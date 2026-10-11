/* v8 ignore start -- production wiring for self-update: real network, npm, launchd and daemon socket; the logic it feeds is unit-tested through injected deps @preserve */
import { execFile as execFileCb, execFileSync, spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseStatusPayload } from "../daemon/cli-render"
import { DEFAULT_DAEMON_SOCKET_PATH, checkDaemonSocketAlive, sendDaemonCommand } from "../daemon/socket-client"
import { activateVersion, getCurrentVersion, getOuroCliHome, pruneOldVersions, validateInstalledVersionForActivation } from "./ouro-version-manager"
import { installRelease, lookupLatestRelease, selfUpdateE2eOverrides, type ReleaseSourceDeps } from "./release-sources"
import type { SelfUpdateDeps } from "./self-update"
import { readUpdateState, writeUpdateState } from "./update-state"
import { chooseUpdaterNodePath, ensureUpdaterAgent, UPDATER_PLIST_LABEL, type UpdaterAgentResult } from "./updater-launchd"
import { readVersionIntent, writeVersionIntent } from "./version-intent"

const DAEMON_UP_TIMEOUT_MS = 10 * 60_000
const DAEMON_HEALTH_WAIT_MS = 90_000

function execFileText(command: string, args: string[], options: { timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ")
        reject(new Error(`${command} ${args[0] ?? ""} failed: ${detail || error.message}`))
        return
      }
      resolve(String(stdout))
    })
  })
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "ouro-self-update" },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
    return await response.json()
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s reaching ${new URL(url).host}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run a command with stdin closed and OURO_UNATTENDED=1. `ouro up` can prompt
 * (for example about manually cloned bundles); unattended, every prompt takes
 * its default answer at once instead of waiting out the restart timeout.
 */
function runDetachedFromStdin(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OURO_UNATTENDED: "1" } })
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`${command} ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${args.join(" ")} exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`))
    })
  })
}

export const releaseSourceDeps: ReleaseSourceDeps = { fetchJson, execFile: execFileText, ...selfUpdateE2eOverrides(process.env) }

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockPath(cliHome: string): string {
  return path.join(cliHome, "self-update.lock")
}

/** The pid holding the update lock when that process is still alive. */
function liveLockOwner(cliHome: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath(cliHome), "utf8"), 10)
    return Number.isFinite(pid) && pid > 0 && isPidAlive(pid) ? pid : null
  } catch {
    return null
  }
}

/** True when another live process is in the middle of an update pass. */
export function isSelfUpdateLockHeld(cliHome: string): boolean {
  const owner = liveLockOwner(cliHome)
  return owner !== null && owner !== process.pid
}

function acquireLock(cliHome: string): (() => void) | null {
  const file = lockPath(cliHome)
  fs.mkdirSync(cliHome, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600)
      fs.writeSync(fd, `${process.pid}\n`)
      fs.closeSync(fd)
      return () => {
        try { fs.unlinkSync(file) } catch { /* already released */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // A lock is stale only when its owner is gone; a long install by a live
      // owner keeps it, however long it takes.
      if (liveLockOwner(cliHome) !== null) return null
      try { fs.unlinkSync(file) } catch { /* raced with the owner releasing it */ }
    }
  }
  return null
}

function versionEntry(cliHome: string, version: string): string {
  return path.join(cliHome, "versions", version, "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
}

async function runningDaemonVersion(socketPath: string): Promise<string | null> {
  try {
    const response = await sendDaemonCommand(socketPath, { kind: "daemon.status" })
    return parseStatusPayload(response.data)?.overview.version ?? null
  } catch {
    return null
  }
}

export function createDefaultSelfUpdateDeps(options: { homeDir?: string; socketPath?: string } = {}): SelfUpdateDeps {
  const homeDir = options.homeDir ?? os.homedir()
  const cliHome = getOuroCliHome(homeDir)
  // The package end-to-end test must never see a daemon on the host machine.
  const socketPath = process.env.OURO_SELF_UPDATE_E2E === "1"
    ? path.join(cliHome, "e2e-no-daemon.sock")
    : options.socketPath ?? DEFAULT_DAEMON_SOCKET_PATH
  const launcher = path.join(cliHome, "bin", "ouro-launcher.js")
  return {
    now: () => Date.now(),
    getCurrentVersion: () => getCurrentVersion({ homeDir }),
    readIntent: () => readVersionIntent({ homeDir }),
    writeIntent: (intent) => writeVersionIntent(intent, { homeDir }),
    readState: () => readUpdateState({ homeDir }),
    writeState: (state) => writeUpdateState(state, { homeDir }),
    lookupLatest: () => lookupLatestRelease(releaseSourceDeps),
    install: (version, lookup) => installRelease(version, lookup, cliHome, releaseSourceDeps),
    validate: (version) => validateInstalledVersionForActivation(version, { homeDir }),
    smokeTest: async (version) => {
      try {
        const output = (await execFileText(process.execPath, [versionEntry(cliHome, version), "--version"], { timeoutMs: 60_000 })).trim()
        return output.includes(version) ? { ok: true } : { ok: false, detail: `--version printed "${output.slice(0, 120)}"` }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    activate: (version) => {
      activateVersion(version, { homeDir })
      pruneOldVersions(undefined, { homeDir })
    },
    isDaemonRunning: () => checkDaemonSocketAlive(socketPath),
    runningDaemonVersion: async () => (await checkDaemonSocketAlive(socketPath)) ? runningDaemonVersion(socketPath) : null,
    restartDaemon: async (expectedVersion) => {
      try {
        await runDetachedFromStdin(process.execPath, [launcher, "up"], DAEMON_UP_TIMEOUT_MS)
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
      const deadline = Date.now() + DAEMON_HEALTH_WAIT_MS
      let seen: string | null = null
      while (Date.now() < deadline) {
        seen = await runningDaemonVersion(socketPath)
        if (seen === expectedVersion) return { ok: true }
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      return { ok: false, detail: seen ? `daemon answered with ${seen}, expected ${expectedVersion}` : "daemon did not answer after ouro up" }
    },
    isDevMode: () => fs.existsSync(path.join(cliHome, "dev-config.json")),
    acquireLock: () => acquireLock(cliHome),
  }
}

function nodeMajorOf(nodePath: string): number | null {
  try {
    fs.accessSync(nodePath, fs.constants.X_OK)
    const version = execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()
    const major = Number.parseInt(version.replace(/^v/, ""), 10)
    return Number.isFinite(major) ? major : null
  } catch {
    return null
  }
}

export function ensureDefaultUpdaterAgent(options: { homeDir?: string } = {}): UpdaterAgentResult | null {
  // The package end-to-end test runs in a throwaway HOME; it must never load
  // a real launch agent on the host.
  if (process.platform !== "darwin" || process.env.OURO_SELF_UPDATE_E2E === "1") return null
  const homeDir = options.homeDir ?? os.homedir()
  const result = ensureUpdaterAgent({
    homeDir,
    userUid: os.userInfo().uid,
    nodePath: chooseUpdaterNodePath({
      execPath: process.execPath,
      runningMajor: Number.parseInt(process.versions.node, 10),
      majorOf: nodeMajorOf,
    }),
    readFile: (filePath) => {
      try { return fs.readFileSync(filePath, "utf8") } catch { return null }
    },
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    exec: (command) => { require("child_process").execSync(command, { stdio: "ignore" }) },
    runningUnderUpdaterAgent: process.env.XPC_SERVICE_NAME === UPDATER_PLIST_LABEL,
    updateInProgress: isSelfUpdateLockHeld(getOuroCliHome(homeDir)),
  })
  emitNervesEvent({
    component: "daemon",
    event: "daemon.self_update_agent_checked",
    message: "checked the unattended updater launch agent",
    meta: { result },
  })
  return result
}

export function isDefaultUpdaterAgentInstalled(options: { homeDir?: string } = {}): boolean | null {
  if (process.platform !== "darwin") return null
  const homeDir = options.homeDir ?? os.homedir()
  return fs.existsSync(path.join(homeDir, "Library", "LaunchAgents", `${UPDATER_PLIST_LABEL}.plist`))
}
/* v8 ignore stop */
