/**
 * Runtime replacement from inside the daemon's own process tree.
 *
 * An agent can run `ouro up` through its shell tool. That `ouro up` is a
 * descendant of the daemon, so it lives in the daemon's launchd job and
 * process group. Replacing the daemon stops that job, and launchd kills the
 * rest of the job's process group with it, including the `ouro up` doing the
 * replacement. It dies after the old daemon's label is booted out and before
 * the new plist is bootstrapped, so nothing is left to start the daemon again
 * (2026-11-16: the daemon stayed down for six days).
 *
 * The fix: when the command is inside the daemon's launchd job, start a
 * detached `ouro up` in its own session and process group, with its output
 * going to a log, and let that helper do the stop, bootout and bootstrap.
 */

import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { DAEMON_PLIST_LABEL } from "./launchd"

/**
 * Written before a runtime replacement boots the daemon's label out and
 * removed once launchd has the new plist. If it outlives
 * STRANDED_REPLACEMENT_AFTER_MS while the label is unloaded, the replacement
 * died halfway. A label someone booted out on purpose has no marker.
 */
export function runtimeReplacementMarkerPath(cliHome: string): string {
  return path.join(cliHome, "daemon", "runtime-replacement-pending")
}

/** Long enough that a live replacement has finished its bootout and bootstrap. */
export const STRANDED_REPLACEMENT_AFTER_MS = 5 * 60_000

export function isRuntimeReplacementStranded(input: {
  markerWrittenAtMs: number | null
  nowMs: number
  labelLoaded: () => boolean
}): boolean {
  if (input.markerWrittenAtMs === null) return false
  if (input.nowMs - input.markerWrittenAtMs < STRANDED_REPLACEMENT_AFTER_MS) return false
  return !input.labelLoaded()
}

export interface RuntimeReplacementHandoffDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  execPath: string
  /** The entry script of the running `ouro` command, rerun as the helper. */
  entryPath: string | undefined
  logPath: string
  /** Opens the helper's log for appending and returns its file descriptor. */
  openLog: (logPath: string) => number
  spawn: (
    file: string,
    args: string[],
    options: { detached: true; stdio: ["ignore", number, number]; env: NodeJS.ProcessEnv },
  ) => { pid?: number; unref: () => void }
}

export interface RuntimeReplacementHandoff {
  pid: number | null
  logPath: string
}

/**
 * launchd sets XPC_SERVICE_NAME to a job's label for every process it starts,
 * and children inherit it, so an agent's shell under the daemon carries the
 * daemon's label. Daemons started before this check existed set it too.
 */
export function isInsideDaemonLaunchdJob(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && env.XPC_SERVICE_NAME === DAEMON_PLIST_LABEL
}

/**
 * Starts the detached helper when the current command is inside the daemon's
 * launchd job, and returns null when no hand-off is needed. Throws when the
 * helper cannot start: replacing in place from inside the job is the failure
 * this module exists to prevent.
 */
export function handOffDaemonRuntimeReplacement(deps: RuntimeReplacementHandoffDeps): RuntimeReplacementHandoff | null {
  if (!isInsideDaemonLaunchdJob(deps.env, deps.platform)) return null
  if (!deps.entryPath) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.runtime_replacement_handoff_failed",
      message: "runtime replacement runs inside the daemon's launchd job but the entry script is unknown",
      meta: { logPath: deps.logPath, reason: "no entry script" },
    })
    throw new Error("could not tell which ouro entry script to run as the detached helper")
  }

  try {
    const logFd = deps.openLog(deps.logPath)
    // Without the daemon's label the helper replaces the daemon itself rather
    // than handing off again.
    const env: NodeJS.ProcessEnv = { ...deps.env, OURO_UNATTENDED: "1" }
    delete env.XPC_SERVICE_NAME
    const child = deps.spawn(deps.execPath, [deps.entryPath, "up"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    })
    child.unref()
    const handoff = { pid: child.pid ?? null, logPath: deps.logPath }
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.runtime_replacement_handed_off",
      message: "runtime replacement started inside the daemon's launchd job; handed it to a detached helper",
      meta: { pid: handoff.pid, logPath: handoff.logPath, entryPath: deps.entryPath },
    })
    return handoff
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.runtime_replacement_handoff_failed",
      message: "could not start the detached runtime replacement helper",
      meta: { logPath: deps.logPath, reason },
    })
    throw new Error(`could not start the detached helper: ${reason}`)
  }
}
