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

export interface DaemonPlistOptions {
  nodePath: string
  entryPath: string
  socketPath: string
  logDir?: string
}

export function generateDaemonPlist(_options: DaemonPlistOptions): string {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_generate_plist",
    message: "generating daemon plist",
    meta: {},
  })
  throw new Error("not implemented")
}

export function installLaunchAgent(_deps: LaunchdDeps, _options: DaemonPlistOptions): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_install",
    message: "installing launch agent",
    meta: {},
  })
  throw new Error("not implemented")
}

export function uninstallLaunchAgent(_deps: LaunchdDeps): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_uninstall",
    message: "uninstalling launch agent",
    meta: {},
  })
  throw new Error("not implemented")
}

export function isDaemonInstalled(_deps: Pick<LaunchdDeps, "existsFile" | "homeDir">): boolean {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_check_installed",
    message: "checking if daemon is installed",
    meta: {},
  })
  throw new Error("not implemented")
}
