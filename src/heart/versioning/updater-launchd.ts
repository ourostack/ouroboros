import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { UPDATER_INTERVAL_SECONDS } from "./update-state"

/**
 * A launchd agent that runs `ouro self-update --unattended` every hour and at
 * login, independent of the Ouro daemon. Updates keep flowing when the
 * daemon is stopped, crashed, or was never started on this machine.
 */
export const UPDATER_PLIST_LABEL = "bot.ouro.updater"

export interface UpdaterAgentDeps {
  homeDir: string
  userUid: number
  nodePath: string
  readFile: (filePath: string) => string | null
  writeFile: (filePath: string, content: string) => void
  mkdirp: (dir: string) => void
  exec: (command: string) => void
  /** True when this process was started by the updater agent itself. */
  runningUnderUpdaterAgent: boolean
}

export type UpdaterAgentResult = "unchanged" | "installed" | "written-reload-pending"

export function updaterPlistPath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${UPDATER_PLIST_LABEL}.plist`)
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function generateUpdaterPlist(options: { homeDir: string; nodePath: string }): string {
  const launcher = path.join(options.homeDir, ".ouro-cli", "bin", "ouro-launcher.js")
  const envPath = [path.dirname(options.nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${UPDATER_PLIST_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${xmlEscape(options.nodePath)}</string>`,
    `    <string>${xmlEscape(launcher)}</string>`,
    `    <string>self-update</string>`,
    `    <string>--unattended</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>StartInterval</key>`,
    `  <integer>${UPDATER_INTERVAL_SECONDS}</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${xmlEscape(envPath)}</string>`,
    `  </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")
}

/**
 * Write the updater plist when it is missing or stale (for example after the
 * node binary moved) and load it. When the updater agent itself is running,
 * reloading would kill the run in progress, so it only rewrites the file and
 * the next interactive `ouro self-update` or `ouro up` reloads it.
 */
export function ensureUpdaterAgent(deps: UpdaterAgentDeps): UpdaterAgentResult {
  const plistPath = updaterPlistPath(deps.homeDir)
  const desired = generateUpdaterPlist({ homeDir: deps.homeDir, nodePath: deps.nodePath })
  const existing = deps.readFile(plistPath)
  const domain = `gui/${deps.userUid}`
  let loaded = true
  try {
    deps.exec(`launchctl print ${domain}/${UPDATER_PLIST_LABEL}`)
  } catch {
    loaded = false
  }
  if (existing === desired && loaded) return "unchanged"

  deps.mkdirp(path.dirname(plistPath))
  deps.writeFile(plistPath, desired)
  if (deps.runningUnderUpdaterAgent) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.self_update_agent_written",
      message: "rewrote the updater launch agent; reload waits for the next interactive run",
      meta: { plistPath },
    })
    return "written-reload-pending"
  }
  if (loaded) {
    try { deps.exec(`launchctl bootout ${domain}/${UPDATER_PLIST_LABEL}`) } catch { /* already gone */ }
  }
  deps.exec(`launchctl bootstrap ${domain} "${plistPath}"`)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.self_update_agent_installed",
    message: "installed the unattended updater launch agent",
    meta: { plistPath, intervalSeconds: UPDATER_INTERVAL_SECONDS },
  })
  return "installed"
}
