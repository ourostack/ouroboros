import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export const DAEMON_PLIST_LABEL = "bot.ouro.daemon"

export interface LaunchdDeps {
  exec: (cmd: string) => void
  writeFile: (filePath: string, content: string) => void
  removeFile: (filePath: string) => void
  existsFile: (filePath: string) => boolean
  mkdirp: (dir: string) => void
  homeDir: string
  userUid: number
}

export interface LaunchdWriteDeps {
  writeFile: (filePath: string, content: string) => void
  mkdirp: (dir: string) => void
  homeDir: string
}

export interface DaemonPlistOptions {
  nodePath: string
  entryPath: string
  socketPath: string
  logDir?: string
  envPath?: string
}

function plistFilePath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${DAEMON_PLIST_LABEL}.plist`)
}

function userLaunchDomain(userUid: number): string {
  return `gui/${userUid}`
}

export function generateDaemonPlist(options: DaemonPlistOptions): string {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_generate_plist",
    message: "generating daemon plist",
    meta: { entryPath: options.entryPath, socketPath: options.socketPath },
  })

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${DAEMON_PLIST_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${options.nodePath}</string>`,
    `    <string>${options.entryPath}</string>`,
    `    <string>--socket</string>`,
    `    <string>${options.socketPath}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
  ]

  if (options.envPath) {
    lines.push(
      `  <key>EnvironmentVariables</key>`,
      `  <dict>`,
      `    <key>PATH</key>`,
      `    <string>${options.envPath}</string>`,
      `  </dict>`,
    )
  }

  if (options.logDir) {
    // PR 1 decision: we no longer emit `StandardErrorPath` for the daemon.
    // The daemon's structured nerves ndjson pipeline (rotated + gzipped via
    // createNdjsonFileSink) is the source of truth for diagnostics. Writing
    // raw process stderr to an unrotated file grew to 366 MB in the wild;
    // dropping the key lets launchd forward stray stderr to the system log
    // where it gets rotated by the OS.
    lines.push(
      `  <key>StandardOutPath</key>`,
      `  <string>${path.join(options.logDir, "ouro-daemon-stdout.log")}</string>`,
    )
  }

  lines.push(`</dict>`, `</plist>`, ``)

  return lines.join("\n")
}

export function writeLaunchAgentPlist(deps: LaunchdWriteDeps, options: DaemonPlistOptions): string {
  const launchAgentsDir = path.join(deps.homeDir, "Library", "LaunchAgents")
  deps.mkdirp(launchAgentsDir)

  if (options.logDir) {
    deps.mkdirp(options.logDir)
  }

  const fullPath = plistFilePath(deps.homeDir)
  const xml = generateDaemonPlist(options)
  deps.writeFile(fullPath, xml)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_plist_written",
    message: "daemon launch agent plist written",
    meta: { plistPath: fullPath, entryPath: options.entryPath, socketPath: options.socketPath },
  })

  return fullPath
}

export function installLaunchAgent(deps: LaunchdDeps, options: DaemonPlistOptions): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_install",
    message: "installing launch agent",
    meta: { entryPath: options.entryPath, socketPath: options.socketPath },
  })

  const fullPath = plistFilePath(deps.homeDir)
  const domain = userLaunchDomain(deps.userUid)

  // Unload existing (best effort) for idempotent re-install
  if (deps.existsFile(fullPath)) {
    try { deps.exec(`launchctl bootout ${domain} "${fullPath}"`) } catch { /* best effort */ }
  }

  writeLaunchAgentPlist(deps, options)

  // Bootstrap the plist so launchd manages crash recovery via KeepAlive.
  // This is safe because ouro up calls this AFTER the daemon is already running,
  // so launchd sees the existing process and just registers for KeepAlive.
  try { deps.exec(`launchctl bootstrap ${domain} "${fullPath}"`) } catch { /* already loaded */ }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_installed",
    message: "launch agent installed with KeepAlive",
    meta: { plistPath: fullPath },
  })
}

export function uninstallLaunchAgent(deps: LaunchdDeps): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_uninstall",
    message: "uninstalling launch agent",
    meta: {},
  })

  const fullPath = plistFilePath(deps.homeDir)
  const domain = userLaunchDomain(deps.userUid)

  if (deps.existsFile(fullPath)) {
    try { deps.exec(`launchctl bootout ${domain} "${fullPath}"`) } catch { /* best effort */ }
    deps.removeFile(fullPath)
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_uninstalled",
    message: "launch agent uninstalled",
    meta: { plistPath: fullPath },
  })
}

export function isDaemonInstalled(deps: Pick<LaunchdDeps, "existsFile" | "homeDir">): boolean {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_check_installed",
    message: "checking if daemon is installed",
    meta: {},
  })

  return deps.existsFile(plistFilePath(deps.homeDir))
}
