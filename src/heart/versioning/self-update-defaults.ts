/* v8 ignore start -- production wiring for self-update: real network, npm, launchd and daemon socket; the logic it feeds is unit-tested through injected deps @preserve */
import { execFile as execFileCb } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseStatusPayload } from "../daemon/cli-render"
import { DEFAULT_DAEMON_SOCKET_PATH, checkDaemonSocketAlive, sendDaemonCommand } from "../daemon/socket-client"
import { activateVersion, getCurrentVersion, getOuroCliHome, pruneOldVersions, validateInstalledVersionForActivation } from "./ouro-version-manager"
import { installRelease, lookupLatestRelease, type ReleaseSourceDeps } from "./release-sources"
import type { SelfUpdateDeps } from "./self-update"
import { readUpdateState, writeUpdateState } from "./update-state"
import { ensureUpdaterAgent, UPDATER_PLIST_LABEL, type UpdaterAgentResult } from "./updater-launchd"
import { readVersionIntent, writeVersionIntent } from "./version-intent"

const LOCK_STALE_MS = 30 * 60_000
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

export const releaseSourceDeps: ReleaseSourceDeps = { fetchJson, execFile: execFileText }

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock(cliHome: string): (() => void) | null {
  const lockPath = path.join(cliHome, "self-update.lock")
  fs.mkdirSync(cliHome, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600)
      fs.writeSync(fd, `${process.pid}\n`)
      fs.closeSync(fd)
      return () => {
        try { fs.unlinkSync(lockPath) } catch { /* already released */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10)
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
        if (Number.isFinite(pid) && isPidAlive(pid) && ageMs < LOCK_STALE_MS) return null
        fs.unlinkSync(lockPath)
      } catch {
        // Raced with the owner releasing it; try again.
      }
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
  const socketPath = options.socketPath ?? DEFAULT_DAEMON_SOCKET_PATH
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
    restartDaemon: async (expectedVersion) => {
      try {
        await execFileText(process.execPath, [launcher, "up"], { timeoutMs: DAEMON_UP_TIMEOUT_MS })
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

export function ensureDefaultUpdaterAgent(options: { homeDir?: string } = {}): UpdaterAgentResult | null {
  if (process.platform !== "darwin") return null
  const homeDir = options.homeDir ?? os.homedir()
  const result = ensureUpdaterAgent({
    homeDir,
    userUid: os.userInfo().uid,
    nodePath: process.execPath,
    readFile: (filePath) => {
      try { return fs.readFileSync(filePath, "utf8") } catch { return null }
    },
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    exec: (command) => { require("child_process").execSync(command, { stdio: "ignore" }) },
    runningUnderUpdaterAgent: process.env.XPC_SERVICE_NAME === UPDATER_PLIST_LABEL,
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
