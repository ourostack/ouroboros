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
}

function plistFilePath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${DAEMON_PLIST_LABEL}.plist`)
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

  if (options.logDir) {
    lines.push(
      `  <key>StandardOutPath</key>`,
      `  <string>${path.join(options.logDir, "ouro-daemon-stdout.log")}</string>`,
      `  <key>StandardErrorPath</key>`,
      `  <string>${path.join(options.logDir, "ouro-daemon-stderr.log")}</string>`,
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

  // Unload existing (best effort) for idempotent re-install
  if (deps.existsFile(fullPath)) {
    try { deps.exec(`launchctl unload "${fullPath}"`) } catch { /* best effort */ }
  }

  writeLaunchAgentPlist(deps, options)

  deps.exec(`launchctl load "${fullPath}"`)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_installed",
    message: "launch agent installed",
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

  if (deps.existsFile(fullPath)) {
    try { deps.exec(`launchctl unload "${fullPath}"`) } catch { /* best effort */ }
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
