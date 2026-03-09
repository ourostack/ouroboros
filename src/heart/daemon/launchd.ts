import { emitNervesEvent } from "../../nerves/runtime"

export const DAEMON_LABEL = "bot.ouro.daemon"

export interface LaunchdExecDeps {
  exec: (cmd: string) => void
  homeDir: string
}

export interface DaemonPlistOptions {
  nodePath: string
  entryPath: string
  socketPath: string
  logDir?: string
}

export interface InstallLaunchAgentOptions extends DaemonPlistOptions {
  deps: LaunchdExecDeps
}

export interface UninstallLaunchAgentOptions {
  deps: LaunchdExecDeps
}

export interface IsDaemonInstalledOptions {
  homeDir: string
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

export function installLaunchAgent(_options: InstallLaunchAgentOptions): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_install",
    message: "installing launch agent",
    meta: {},
  })
  throw new Error("not implemented")
}

export function uninstallLaunchAgent(_options: UninstallLaunchAgentOptions): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_uninstall",
    message: "uninstalling launch agent",
    meta: {},
  })
  throw new Error("not implemented")
}

export function isDaemonInstalled(_options: IsDaemonInstalledOptions): boolean {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.launchd_check_installed",
    message: "checking if daemon is installed",
    meta: {},
  })
  throw new Error("not implemented")
}
