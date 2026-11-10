/**
 * Supervision for the daemon on Linux machines without launchd.
 *
 * `ouro service install --init sysv|systemd` writes a service that runs the
 * daemon in the foreground and restarts it when it fails: a SysV-style init
 * script with a respawn loop (BusyBox init, Buildroot appliances, Alpine's
 * OpenRC-less images), or a systemd unit. Either one restarts the daemon only
 * when it exits non-zero, as `Restart=on-failure` does, because the daemon
 * exits 0 for `ouro stop` and SIGTERM and 1 for a crash or a failed start.
 * That keeps `ouro stop` and `ouro up`'s version replacement working: the
 * supervisor lets a deliberate stop stand, and `ouro up` starts the daemon
 * again through the service, so it is supervised from then on.
 *
 * The install is recorded in `~/.ouro-cli/service.json`, which is how
 * `ouro up` knows to start through the service instead of a detached spawn.
 */

import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export type LinuxServiceInit = "sysv" | "systemd"

export interface LinuxServiceRecord {
  schemaVersion: 1
  init: LinuxServiceInit
  /** The init script or unit file this install wrote. */
  path: string
  /** systemd only: whether the unit is a user unit (`systemctl --user`). */
  user?: boolean
  /** The socket the supervised daemon listens on. */
  socketPath: string
}

/** How the supervisor treats a small or crashing host. Every field is optional. */
export interface ServiceSupervision {
  /** Wait, without counting a crash, until /proc/meminfo MemAvailable reaches this many MB before each start. */
  minMemAvailableMb?: number
  /** Node's --max-old-space-size for the daemon, in MB. */
  maxOldSpaceMb?: number
  /** oom_score_adj for the daemon and its workers (-1000..1000); higher is killed first under memory pressure. */
  oomScoreAdj?: number
  /** The file that gets one line when the circuit breaker stops respawning. Defaults to ~/.ouro-cli/service-alert.log. */
  alertFile?: string
}

export interface LinuxServiceOptions {
  nodePath: string
  entryPath: string
  socketPath: string
  homeDir: string
  ouroCliHome: string
  envPath?: string
  supervision?: ServiceSupervision
}

export interface LinuxServiceDeps {
  writeFile: (filePath: string, content: string, mode: number) => void
  readFile: (filePath: string) => string
  removeFile: (filePath: string) => void
  existsFile: (filePath: string) => boolean
  mkdirp: (dir: string) => void
  /** Runs a command with arguments, no shell; throws on a non-zero exit. */
  run: (file: string, args: string[]) => void
  isRoot: boolean
}

export const SERVICE_NAME = "ouro"
/** Restart delays double from the first to the cap; a run this long resets them. */
const RESTART_DELAY_FIRST_SECONDS = 5
const RESTART_DELAY_CAP_SECONDS = 600
const STABLE_RUN_SECONDS = 600
/** The circuit breaker: this many crashes inside the window stops respawning. */
const BREAKER_CRASHES = 5
const BREAKER_WINDOW_SECONDS = 600
/** How often a supervisor waiting for memory checks MemAvailable again. */
const MEMORY_RECHECK_SECONDS = 30

export function serviceRecordPath(ouroCliHome: string): string {
  return path.join(ouroCliHome, "service.json")
}

/** Quotes a value for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Quotes a value for a systemd unit's ExecStart or Environment line. */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function defaultServicePath(init: LinuxServiceInit, homeDir: string, isRoot: boolean): string {
  if (init === "sysv") return path.join("/etc", "init.d", `S99${SERVICE_NAME}`)
  return isRoot
    ? path.join("/etc", "systemd", "system", `${SERVICE_NAME}.service`)
    : path.join(homeDir, ".config", "systemd", "user", `${SERVICE_NAME}.service`)
}

export function defaultAlertFile(ouroCliHome: string): string {
  return path.join(ouroCliHome, "service-alert.log")
}

export function generateSysvInitScript(options: LinuxServiceOptions): string {
  const logDir = path.join(options.ouroCliHome, "daemon", "logs")
  const supervision = options.supervision ?? {}
  const lines = [
    "#!/bin/sh",
    "# Ouro daemon, written by `ouro service install --init sysv`.",
    "# Runs the daemon in the foreground and restarts it when it fails (non-zero",
    "# exit). A clean exit, such as `ouro stop`, is left stopped. Restarts back off",
    `# from ${RESTART_DELAY_FIRST_SECONDS} s, doubling to ${RESTART_DELAY_CAP_SECONDS} s; ${BREAKER_CRASHES} crashes in ${BREAKER_WINDOW_SECONDS / 60} minutes stop`,
    "# respawning and append one line to ALERT_FILE.",
    "",
    `NODE=${shellQuote(options.nodePath)}`,
    `ENTRY=${shellQuote(options.entryPath)}`,
    `SOCKET=${shellQuote(options.socketPath)}`,
    `OURO_HOME=${shellQuote(options.homeDir)}`,
    `LOG_DIR=${shellQuote(logDir)}`,
    `PIDFILE=${shellQuote(path.join(options.ouroCliHome, "service.pid"))}`,
    `ALERT_FILE=${shellQuote(supervision.alertFile ?? defaultAlertFile(options.ouroCliHome))}`,
    `MIN_MEM_AVAILABLE_KB=${(supervision.minMemAvailableMb ?? 0) * 1024}`,
    `MAX_OLD_SPACE_MB=${supervision.maxOldSpaceMb ?? ""}`,
    `OOM_SCORE_ADJ=${supervision.oomScoreAdj ?? ""}`,
    ...(options.envPath ? [`PATH=${shellQuote(options.envPath)}`, "export PATH"] : []),
    "",
    "note() {",
    "  echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) ouro-service: $*\" >>\"$LOG_DIR/ouro-service.log\"",
    "}",
    "",
    "mem_available_kb() {",
    "  while read -r key value unit; do",
    "    if [ \"$key\" = \"MemAvailable:\" ]; then echo \"$value\"; return; fi",
    "  done </proc/meminfo",
    "}",
    "",
    "# Before each start, wait (without counting a crash) until MemAvailable reaches the floor.",
    "wait_for_memory() {",
    "  [ \"$MIN_MEM_AVAILABLE_KB\" -gt 0 ] || return 0",
    "  waiting=0",
    "  while [ \"$stopping\" -eq 0 ]; do",
    "    available=$(mem_available_kb 2>/dev/null)",
    "    if [ -z \"$available\" ] || [ \"$available\" -ge \"$MIN_MEM_AVAILABLE_KB\" ]; then",
    "      [ \"$waiting\" -eq 1 ] && note \"MemAvailable ${available:-unknown} kB reached the floor; starting\"",
    "      return 0",
    "    fi",
    "    [ \"$waiting\" -eq 0 ] && note \"MemAvailable ${available} kB is below the ${MIN_MEM_AVAILABLE_KB} kB floor; waiting\"",
    "    waiting=1",
    `    sleep ${MEMORY_RECHECK_SECONDS} &`,
    "    wait $!",
    "  done",
    "}",
    "",
    "supervise() {",
    "  stopping=0",
    "  child=",
    `  delay=${RESTART_DELAY_FIRST_SECONDS}`,
    "  crashes=",
    "  trap 'stopping=1; [ -n \"$child\" ] && kill \"$child\" 2>/dev/null' TERM INT",
    "  while [ \"$stopping\" -eq 0 ]; do",
    "    wait_for_memory",
    "    [ \"$stopping\" -eq 1 ] && break",
    "    started=$(date +%s)",
    "    # The subshell sets oom_score_adj and then becomes node, so the daemon and its workers inherit it.",
    "    (",
    "      [ -n \"$OOM_SCORE_ADJ\" ] && echo \"$OOM_SCORE_ADJ\" >/proc/self/oom_score_adj 2>/dev/null",
    "      HOME=\"$OURO_HOME\" exec \"$NODE\" ${MAX_OLD_SPACE_MB:+--max-old-space-size=$MAX_OLD_SPACE_MB} \"$ENTRY\" --socket \"$SOCKET\"",
    "    ) >>\"$LOG_DIR/ouro-daemon-stdout.log\" 2>&1 &",
    "    child=$!",
    "    wait \"$child\"",
    "    code=$?",
    "    if [ \"$stopping\" -eq 1 ]; then wait \"$child\" 2>/dev/null; break; fi",
    "    [ \"$code\" -eq 0 ] && break",
    "    now=$(date +%s)",
    `    [ $((now - started)) -ge ${STABLE_RUN_SECONDS} ] && delay=${RESTART_DELAY_FIRST_SECONDS}`,
    "    recent=",
    "    count=1",
    "    for at in $crashes; do",
    `      if [ $((now - at)) -lt ${BREAKER_WINDOW_SECONDS} ]; then recent=\"$recent $at\"; count=$((count + 1)); fi`,
    "    done",
    "    crashes=\"$recent $now\"",
    `    if [ "$count" -ge ${BREAKER_CRASHES} ]; then`,
    `      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ouro: the daemon crashed $count times in ${BREAKER_WINDOW_SECONDS / 60} minutes (last exit $code); stopped respawning. Fix the cause, then run: $0 start" >>"$ALERT_FILE"`,
    "      note \"circuit breaker open after $count crashes; stopped respawning\"",
    "      break",
    "    fi",
    "    note \"daemon exited $code; restarting in ${delay} s\"",
    "    sleep \"$delay\" &",
    "    wait $!",
    "    delay=$((delay * 2))",
    `    [ "$delay" -gt ${RESTART_DELAY_CAP_SECONDS} ] && delay=${RESTART_DELAY_CAP_SECONDS}`,
    "  done",
    "  rm -f \"$PIDFILE\"",
    "}",
    "",
    "running() {",
    "  [ -f \"$PIDFILE\" ] && kill -0 \"$(cat \"$PIDFILE\")\" 2>/dev/null",
    "}",
    "",
    "case \"$1\" in",
    "  start)",
    "    if running; then echo \"ouro: already running\"; exit 0; fi",
    "    mkdir -p \"$LOG_DIR\"",
    "    supervise </dev/null >/dev/null 2>&1 &",
    "    echo $! >\"$PIDFILE\"",
    "    echo \"ouro: started\"",
    "    ;;",
    "  stop)",
    "    if ! running; then echo \"ouro: not running\"; exit 0; fi",
    "    kill \"$(cat \"$PIDFILE\")\"",
    "    i=0",
    "    while running && [ \"$i\" -lt 30 ]; do sleep 1; i=$((i + 1)); done",
    "    echo \"ouro: stopped\"",
    "    ;;",
    "  restart)",
    "    \"$0\" stop",
    "    \"$0\" start",
    "    ;;",
    "  status)",
    "    if running; then echo \"ouro: running\"; else echo \"ouro: stopped\"; exit 3; fi",
    "    ;;",
    "  *)",
    "    echo \"Usage: $0 {start|stop|restart|status}\"",
    "    exit 1",
    "    ;;",
    "esac",
    "",
  ]
  return lines.join("\n")
}

export function generateSystemdUnit(options: LinuxServiceOptions, user: boolean): string {
  const supervision = options.supervision ?? {}
  const maxOldSpace = supervision.maxOldSpaceMb ? `--max-old-space-size=${supervision.maxOldSpaceMb} ` : ""
  const lines = [
    "# Ouro daemon, written by `ouro service install --init systemd`.",
    "[Unit]",
    "Description=Ouro daemon",
    "After=network-online.target",
    "Wants=network-online.target",
    // The circuit breaker: after this many starts in the window systemd leaves the unit failed.
    `StartLimitIntervalSec=${BREAKER_WINDOW_SECONDS}`,
    `StartLimitBurst=${BREAKER_CRASHES}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdQuote(options.nodePath)} ${maxOldSpace}${systemdQuote(options.entryPath)} --socket ${systemdQuote(options.socketPath)}`,
    `Environment=${systemdQuote(`HOME=${options.homeDir}`)}`,
    ...(options.envPath ? [`Environment=${systemdQuote(`PATH=${options.envPath}`)}`] : []),
    // A clean exit (ouro stop, SIGTERM) stays stopped; a crash or failed start is retried.
    "Restart=on-failure",
    `RestartSec=${RESTART_DELAY_FIRST_SECONDS}`,
    // systemd 254+ grows the delay to the cap; older versions ignore these and keep RestartSec.
    "RestartSteps=7",
    `RestartMaxDelaySec=${RESTART_DELAY_CAP_SECONDS}`,
    ...(supervision.oomScoreAdj !== undefined ? [`OOMScoreAdjust=${supervision.oomScoreAdj}`] : []),
    "",
    "[Install]",
    `WantedBy=${user ? "default.target" : "multi-user.target"}`,
    "",
  ]
  return lines.join("\n")
}

function systemctl(record: Pick<LinuxServiceRecord, "user">, args: string[]): string[] {
  return record.user ? ["--user", ...args] : args
}

export function readServiceRecord(deps: Pick<LinuxServiceDeps, "readFile" | "existsFile">, ouroCliHome: string): LinuxServiceRecord | null {
  const recordPath = serviceRecordPath(ouroCliHome)
  if (!deps.existsFile(recordPath)) return null
  try {
    const parsed = JSON.parse(deps.readFile(recordPath)) as Partial<LinuxServiceRecord>
    if (parsed.schemaVersion !== 1 || (parsed.init !== "sysv" && parsed.init !== "systemd") || typeof parsed.path !== "string" || typeof parsed.socketPath !== "string") return null
    return { schemaVersion: 1, init: parsed.init, path: parsed.path, ...(parsed.user ? { user: true } : {}), socketPath: parsed.socketPath }
  } catch {
    return null
  }
}

export interface InstallLinuxServiceResult {
  record: LinuxServiceRecord
  content: string
}

export function installLinuxService(
  deps: LinuxServiceDeps,
  options: LinuxServiceOptions,
  request: { init: LinuxServiceInit; path?: string },
): InstallLinuxServiceResult {
  const user = request.init === "systemd" && !deps.isRoot
  const servicePath = request.path ?? defaultServicePath(request.init, options.homeDir, deps.isRoot)
  const content = request.init === "sysv" ? generateSysvInitScript(options) : generateSystemdUnit(options, user)
  deps.mkdirp(path.dirname(servicePath))
  deps.writeFile(servicePath, content, request.init === "sysv" ? 0o755 : 0o644)
  const record: LinuxServiceRecord = { schemaVersion: 1, init: request.init, path: servicePath, ...(user ? { user: true } : {}), socketPath: options.socketPath }
  if (request.init === "systemd") {
    deps.run("systemctl", systemctl(record, ["daemon-reload"]))
    deps.run("systemctl", systemctl(record, ["enable", path.basename(servicePath)]))
  }
  deps.mkdirp(options.ouroCliHome)
  deps.writeFile(serviceRecordPath(options.ouroCliHome), `${JSON.stringify(record, null, 2)}\n`, 0o644)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.service_installed",
    message: "installed the daemon as a supervised service",
    meta: { init: record.init, path: record.path, user: !!record.user },
  })
  return { record, content }
}

export function uninstallLinuxService(deps: LinuxServiceDeps, ouroCliHome: string): LinuxServiceRecord | null {
  const record = readServiceRecord(deps, ouroCliHome)
  if (!record) return null
  if (record.init === "systemd") {
    try {
      deps.run("systemctl", systemctl(record, ["disable", "--now", path.basename(record.path)]))
    } catch {
      // Already disabled or never enabled; removing the unit is what matters.
    }
  } else if (deps.existsFile(record.path)) {
    try {
      deps.run(record.path, ["stop"])
    } catch {
      // Not running; removing the script is what matters.
    }
  }
  if (deps.existsFile(record.path)) deps.removeFile(record.path)
  if (record.init === "systemd") deps.run("systemctl", systemctl(record, ["daemon-reload"]))
  deps.removeFile(serviceRecordPath(ouroCliHome))
  emitNervesEvent({
    component: "daemon",
    event: "daemon.service_uninstalled",
    message: "removed the daemon's supervised service",
    meta: { init: record.init, path: record.path },
  })
  return record
}

/** Starts the daemon through the installed service; false when none is installed. */
/**
 * Start the daemon through the installed service. Returns false, so the caller
 * spawns the daemon itself, when no service is installed, when the service is
 * bound to a different socket, or when the init system refuses the start.
 */
export function startLinuxService(deps: Pick<LinuxServiceDeps, "readFile" | "existsFile" | "run">, ouroCliHome: string, socketPath: string): boolean {
  const record = readServiceRecord(deps, ouroCliHome)
  if (!record || record.socketPath !== socketPath) return false
  try {
    if (record.init === "systemd") deps.run("systemctl", systemctl(record, ["start", path.basename(record.path)]))
    // SysV: `restart`, not `start`. This runs only when the daemon's socket is dead, for
    // example right after `ouro up` stopped an older daemon to replace it. That daemon
    // exits 0, so its supervisor is on its way out too; `start` in that moment sees it
    // still running, says "already running", and nothing brings a daemon back. `restart`
    // waits for the old supervisor to finish and starts a fresh one.
    else deps.run(record.path, ["restart"])
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.service_start_failed",
      message: "the supervised service did not start; spawning the daemon directly",
      meta: { init: record.init, path: record.path, error: error instanceof Error ? error.message : String(error) },
    })
    return false
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.service_started",
    message: "started the daemon through its supervised service",
    meta: { init: record.init, path: record.path },
  })
  return true
}
