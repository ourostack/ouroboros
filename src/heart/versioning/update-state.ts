import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Machine-local record of the unattended updater's last run. `ouro status`
 * reads it so a machine that cannot update says so instead of silently
 * aging on an old version.
 */
export type SelfUpdateOutcome =
  | "updated"
  | "current"
  | "pinned"
  | "unreachable"
  | "install-failed"
  | "rejected"
  | "rolled-back"

export interface SelfUpdateState {
  schemaVersion: 1
  lastRunAt: string
  outcome: SelfUpdateOutcome
  currentVersion: string | null
  latestVersion?: string
  /** Release source that answered the version lookup or served the install. */
  source?: string
  detail?: string
  /** Versions that failed their smoke test or health check; never retried. */
  failedVersions: string[]
  /** When this updater first saw a pin that carries no pinnedAt. */
  pinFirstSeenAt?: string
  consecutiveFailures: number
}

export interface UpdateStateDeps {
  homeDir?: string
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string
  writeFileSync?: (filePath: string, data: string, options: fs.WriteFileOptions) => void
  renameSync?: (oldPath: string, newPath: string) => void
  mkdirSync?: (dir: string, options: fs.MakeDirectoryOptions) => void
}

export const UPDATER_INTERVAL_SECONDS = 60 * 60

export function updateStatePath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".ouro-cli", "update-state.json")
}

export function readUpdateState(deps: UpdateStateDeps = {}): SelfUpdateState | null {
  const readFileSync = deps.readFileSync ?? fs.readFileSync
  try {
    const parsed = JSON.parse(readFileSync(updateStatePath(deps.homeDir), "utf8")) as Partial<SelfUpdateState>
    if (parsed?.schemaVersion !== 1 || typeof parsed.lastRunAt !== "string" || typeof parsed.outcome !== "string") return null
    return {
      ...parsed,
      failedVersions: Array.isArray(parsed.failedVersions) ? parsed.failedVersions.filter((v): v is string => typeof v === "string") : [],
      consecutiveFailures: typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
    } as SelfUpdateState
  } catch {
    return null
  }
}

export function writeUpdateState(state: SelfUpdateState, deps: UpdateStateDeps = {}): void {
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync
  const renameSync = deps.renameSync ?? fs.renameSync
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  const destination = updateStatePath(deps.homeDir)
  mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  renameSync(temporary, destination)
  emitNervesEvent({
    level: ["updated", "current", "pinned"].includes(state.outcome) ? "info" : "warn",
    component: "daemon",
    event: "daemon.self_update_state_written",
    message: "recorded the unattended updater outcome",
    meta: { outcome: state.outcome, currentVersion: state.currentVersion, latestVersion: state.latestVersion ?? null, detail: state.detail ?? null },
  })
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * One line for `ouro status`. Problems lead with "needs attention" so a
 * stuck machine is visible at a glance.
 */
export function formatUpdateStatusLine(
  state: SelfUpdateState | null,
  options: { now: number; updaterInstalled: boolean | null },
): string {
  if (!state) {
    return options.updaterInstalled === false
      ? "Updates: needs attention: the unattended updater is not installed; run `ouro self-update` once"
      : "Updates: no update check recorded yet; run `ouro self-update`"
  }
  const ageMs = options.now - Date.parse(state.lastRunAt)
  const age = formatAge(ageMs)
  const stale = ageMs > UPDATER_INTERVAL_SECONDS * 1000 * 3
  const version = state.currentVersion ?? "unknown version"
  let line: string
  switch (state.outcome) {
    case "updated":
      line = `Updates: updated to ${version} ${age}${state.source ? ` via ${state.source}` : ""}`
      break
    case "current":
      line = `Updates: current at ${version} (checked ${age}${state.source ? ` via ${state.source}` : ""})`
      break
    case "pinned":
      line = `Updates: pinned to ${version} (checked ${age}; ${state.detail ?? "pin honored"})`
      break
    default:
      line = `Updates: needs attention: ${state.outcome} ${age} on ${version}${state.latestVersion ? ` (latest ${state.latestVersion})` : ""}: ${state.detail ?? "no detail"}`
  }
  if (stale) {
    line += `; needs attention: the updater has not run since ${state.lastRunAt}`
  }
  if (options.updaterInstalled === false) {
    line += "; needs attention: the unattended updater is not installed; run `ouro self-update` once"
  }
  return line
}
