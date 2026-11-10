import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * This machine's choice about unattended updates where no launchd agent runs
 * them (Linux). Off unless a person turns it on with `ouro self-update enable`:
 * on a small device an install (npm, about 230 MB peak and a full copy on
 * disk) competes with everything else the device runs.
 */
export interface HostSelfUpdateConfig {
  schemaVersion: 1
  enabled: boolean
  /** Install without optional dependencies (`npm_config_omit=optional`). */
  lean: boolean
  /** Do not start an install while MemAvailable is below this. */
  minMemAvailableMb: number
  /** Disk to leave free beyond the new version and its 64 MiB headroom. */
  reserveMb: number
  /** Installed versions to keep after an update (current and previous always stay). Absent means the default, 5. */
  keepVersions?: number
}

export const DEFAULT_SELF_UPDATE_MIN_MEM_AVAILABLE_MB = 250
export const DEFAULT_SELF_UPDATE_RESERVE_MB = 0
export const DEFAULT_SELF_UPDATE_KEEP_VERSIONS = 5
export const MIN_SELF_UPDATE_KEEP_VERSIONS = 2

export function hostSelfUpdatePath(cliHome: string): string {
  return path.join(cliHome, "self-update.json")
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** The saved choice, or null when there is none or it is unreadable (both mean off). */
export function readHostSelfUpdateConfig(cliHome: string): HostSelfUpdateConfig | null {
  let parsed: Partial<HostSelfUpdateConfig>
  try {
    parsed = JSON.parse(fs.readFileSync(hostSelfUpdatePath(cliHome), "utf8")) as Partial<HostSelfUpdateConfig>
  } catch {
    return null
  }
  if (parsed?.schemaVersion !== 1 || typeof parsed.enabled !== "boolean" || typeof parsed.lean !== "boolean"
    || !nonNegativeInteger(parsed.minMemAvailableMb) || !nonNegativeInteger(parsed.reserveMb)
    || (parsed.keepVersions !== undefined && (!nonNegativeInteger(parsed.keepVersions) || parsed.keepVersions < MIN_SELF_UPDATE_KEEP_VERSIONS))) {
    return null
  }
  return {
    schemaVersion: 1, enabled: parsed.enabled, lean: parsed.lean, minMemAvailableMb: parsed.minMemAvailableMb, reserveMb: parsed.reserveMb,
    ...(parsed.keepVersions !== undefined ? { keepVersions: parsed.keepVersions } : {}),
  }
}

export function writeHostSelfUpdateConfig(cliHome: string, config: HostSelfUpdateConfig): void {
  fs.mkdirSync(cliHome, { recursive: true })
  const target = hostSelfUpdatePath(cliHome)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.host_self_update_configured",
    message: config.enabled ? "unattended updates turned on for this machine" : "unattended updates turned off for this machine",
    meta: { ...config },
  })
}

export function renderHostSelfUpdateConfig(config: HostSelfUpdateConfig | null): string {
  if (!config?.enabled) return "unattended updates on this machine: off (turn on with `ouro self-update enable`)"
  return [
    "unattended updates on this machine: on",
    `  install: ${config.lean ? "lean (no optional dependencies)" : "full"}, at the lowest CPU and I/O priority`,
    `  waits while MemAvailable is below ${config.minMemAvailableMb} MB`,
    `  keeps ${config.reserveMb} MB free beyond the new version and its 64 MiB headroom`,
    `  keeps the newest ${config.keepVersions ?? DEFAULT_SELF_UPDATE_KEEP_VERSIONS} versions (current and previous always); when an install would not fit, first removes all but current and previous`,
  ].join("\n")
}

/** MemAvailable from /proc/meminfo text, in bytes, or null. */
export function memAvailableBytes(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)
  return match ? Number(match[1]) * 1024 : null
}

/**
 * The updater's command line: `ionice -c 3` and `nice -n 19` in front of node
 * when this host has them, so an install yields CPU and disk to everything else.
 */
export function gentleUpdaterCommand(nodePath: string, args: string[], which: (command: string) => string | null): { file: string; args: string[] } {
  const prefix: string[] = []
  const ionice = which("ionice")
  if (ionice) prefix.push(ionice, "-c", "3")
  const nice = which("nice")
  if (nice) prefix.push(nice, "-n", "19")
  const [file, ...rest] = [...prefix, nodePath, ...args]
  return { file, args: rest }
}
