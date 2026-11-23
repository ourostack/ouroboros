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

export interface RuntimeReplacementHandoffDeps extends DaemonJobDetectionDeps {
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

/** Set in the helper's env so the helper does the replacement instead of handing off again. */
export const RUNTIME_REPLACEMENT_HELPER_ENV = "OURO_RUNTIME_REPLACEMENT_HELPER"

export type DaemonJobCheckReason =
  | "not_macos"
  | "replacement_helper"
  | "launchd_label"
  | "daemon_ancestor"
  | "not_descendant"
  | "no_daemon_job"
  | "launchctl_failed"
  | "process_table_failed"

export interface DaemonJobCheck {
  inside: boolean
  reason: DaemonJobCheckReason
  xpcServiceName: string | null
  daemonPid: number | null
  error?: string
}

export interface DaemonJobDetectionDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** The pid of the command asking. */
  pid: number
  /** The daemon job's running pid, or null when the job isn't loaded or has no process. Throws when launchd can't be asked. */
  readDaemonJobPid: () => number | null
  /** pid to parent pid for every process. Throws when the table can't be read. */
  readProcessParents: () => Map<number, number>
}

/** Parent links are followed at most this many times, so a corrupt table can't loop forever. */
const MAX_ANCESTRY_DEPTH = 128

/**
 * Decides whether this command runs inside the daemon's launchd job.
 *
 * launchd gives the job's processes XPC_SERVICE_NAME=bot.ouro.daemon, but that
 * label isn't enough by itself: Apple's /bin/sh, bash and zsh set
 * XPC_SERVICE_NAME=0 for every child they fork, so an `ouro up` an agent's
 * shell runs in a pipeline sees "0" (2026-11-22 live test). Being a descendant
 * of the job's running pid settles it. When launchd or the process table can't
 * be read the answer is "inside": a needless hand-off costs seconds, and a
 * missed one strands the daemon.
 */
export function detectDaemonLaunchdJob(deps: DaemonJobDetectionDeps): DaemonJobCheck {
  const xpcServiceName = deps.env.XPC_SERVICE_NAME ?? null
  const result = (inside: boolean, reason: DaemonJobCheckReason, daemonPid: number | null = null, error?: string): DaemonJobCheck =>
    ({ inside, reason, xpcServiceName, daemonPid, ...(error === undefined ? {} : { error }) })

  if (deps.platform !== "darwin") return result(false, "not_macos")
  if (deps.env[RUNTIME_REPLACEMENT_HELPER_ENV] === "1") return result(false, "replacement_helper")
  if (xpcServiceName === DAEMON_PLIST_LABEL) return result(true, "launchd_label")

  let daemonPid: number | null
  try {
    daemonPid = deps.readDaemonJobPid()
  } catch (error) {
    return result(true, "launchctl_failed", null, formatError(error))
  }
  if (daemonPid === null) return result(false, "no_daemon_job")

  let parents: Map<number, number>
  try {
    parents = deps.readProcessParents()
  } catch (error) {
    return result(true, "process_table_failed", daemonPid, formatError(error))
  }
  let current: number | undefined = deps.pid
  for (let depth = 0; current !== undefined && current > 1 && depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (current === daemonPid) return result(true, "daemon_ancestor", daemonPid)
    current = parents.get(current)
  }
  return result(false, "not_descendant", daemonPid)
}

/** The running pid from `launchctl print` output, or null when the job has no process. */
export function parseLaunchctlJobPid(output: string): number | null {
  const match = /^\s*pid = (\d+)\s*$/m.exec(output)
  return match ? Number(match[1]) : null
}

/** pid to parent pid from `ps -axo pid=,ppid=` output. */
export function parseProcessParents(output: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parents.set(Number(match[1]), Number(match[2]))
  }
  return parents
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Starts the detached helper when the current command is inside the daemon's
 * launchd job, and returns null when no hand-off is needed. Throws when the
 * helper cannot start: replacing in place from inside the job is the failure
 * this module exists to prevent.
 */
export function handOffDaemonRuntimeReplacement(deps: RuntimeReplacementHandoffDeps): RuntimeReplacementHandoff | null {
  const check = detectDaemonLaunchdJob(deps)
  emitNervesEvent({
    level: check.error === undefined ? "info" : "warn",
    component: "daemon",
    event: "daemon.runtime_replacement_job_check",
    message: check.inside
      ? "runtime replacement runs inside the daemon's launchd job"
      : "runtime replacement runs outside the daemon's launchd job",
    meta: { ...check },
  })
  if (!check.inside) return null
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
    const env: NodeJS.ProcessEnv = { ...deps.env, OURO_UNATTENDED: "1", [RUNTIME_REPLACEMENT_HELPER_ENV]: "1" }
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
