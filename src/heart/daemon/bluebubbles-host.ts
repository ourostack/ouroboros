import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export const BLUEBUBBLES_APP_PATH = "/Applications/BlueBubbles.app"
export const BLUEBUBBLES_EXECUTABLE_PATH = `${BLUEBUBBLES_APP_PATH}/Contents/MacOS/BlueBubbles`
export const BLUEBUBBLES_LAUNCH_AGENT_LABEL = "com.bluebubbles.server"

export type BlueBubblesHostAction = "install" | "status" | "repair" | "remove"

export interface BlueBubblesHostCommandResult {
  ok: boolean
  detail: string
}

export interface BlueBubblesHostDeps {
  platform: NodeJS.Platform
  homeDir: string
  uid: number
  existsSync: (filePath: string) => boolean
  readFileSync: (filePath: string) => string
  mkdirSync: (directoryPath: string, options: { recursive: true }) => void
  writeFileSync: (filePath: string, content: string, options?: { mode?: number }) => void
  unlinkSync: (filePath: string) => void
  launchctl: (args: string[]) => BlueBubblesHostCommandResult
  isProcessRunning: () => boolean
  probeHttp?: () => Promise<{ ok: boolean; detail: string }>
}

export interface BlueBubblesHostState {
  app: "present" | "missing"
  plist: "current" | "missing" | "drifted"
  service: "loaded" | "not-loaded"
  serviceDetail: string
  process: "running" | "not-running"
  http: { ok: boolean | null; detail: string }
  plistPath: string
  launchdDomain: string
  launchAgentLabel: typeof BLUEBUBBLES_LAUNCH_AGENT_LABEL
}

export interface BlueBubblesHostActionResult {
  action: BlueBubblesHostAction
  changed: boolean
  state: BlueBubblesHostState
}

export function blueBubblesLaunchAgentPlist(appExecutablePath = BLUEBUBBLES_EXECUTABLE_PATH): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>AssociatedBundleIdentifiers</key>
        <array>
            <string>com.BlueBubbles.BlueBubbles-Server</string>
        </array>
        <key>Label</key>
        <string>com.bluebubbles.server</string>
        <key>Program</key>
        <string>${appExecutablePath}</string>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
	        <key>SuccessfulExit</key>
	        <false/>
            <key>Crashed</key>
            <true/>
	    </dict>
    </dict>
</plist>`
}

export function blueBubblesLaunchAgentPath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${BLUEBUBBLES_LAUNCH_AGENT_LABEL}.plist`)
}

function requireMacOS(deps: Pick<BlueBubblesHostDeps, "platform">): void {
  if (deps.platform !== "darwin") throw new Error("BlueBubbles host lifecycle requires macOS")
}

function launchdDomain(deps: Pick<BlueBubblesHostDeps, "uid">): string {
  return `gui/${deps.uid}`
}

function serviceTarget(deps: Pick<BlueBubblesHostDeps, "uid">): string {
  return `${launchdDomain(deps)}/${BLUEBUBBLES_LAUNCH_AGENT_LABEL}`
}

function requireLaunchctl(result: BlueBubblesHostCommandResult, operation: string): void {
  if (!result.ok) throw new Error(`launchctl ${operation} failed: ${result.detail}`)
}

export async function inspectBlueBubblesHost(deps: BlueBubblesHostDeps): Promise<BlueBubblesHostState> {
  requireMacOS(deps)
  const plistPath = blueBubblesLaunchAgentPath(deps.homeDir)
  const expectedPlist = blueBubblesLaunchAgentPlist()
  let plist: BlueBubblesHostState["plist"] = "missing"
  if (deps.existsSync(plistPath)) {
    try {
      plist = deps.readFileSync(plistPath) === expectedPlist ? "current" : "drifted"
    } catch {
      plist = "drifted"
    }
  }
  const launchd = deps.launchctl(["print", serviceTarget(deps)])
  const http = deps.probeHttp
    ? await deps.probeHttp()
    : { ok: null, detail: "HTTP health was not configured for this host inspection" }
  const state: BlueBubblesHostState = {
    app: deps.existsSync(BLUEBUBBLES_APP_PATH) ? "present" : "missing",
    plist,
    service: launchd.ok ? "loaded" : "not-loaded",
    serviceDetail: launchd.detail,
    process: deps.isProcessRunning() ? "running" : "not-running",
    http,
    plistPath,
    launchdDomain: launchdDomain(deps),
    launchAgentLabel: BLUEBUBBLES_LAUNCH_AGENT_LABEL,
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bluebubbles_host_inspected",
    message: "inspected native BlueBubbles host lifecycle",
    meta: {
      app: state.app,
      plist: state.plist,
      service: state.service,
      process: state.process,
      httpOk: state.http.ok,
      launchdDomain: state.launchdDomain,
    },
  })
  return state
}

function writeNativePlist(deps: BlueBubblesHostDeps, plistPath: string): void {
  deps.mkdirSync(path.dirname(plistPath), { recursive: true })
  deps.writeFileSync(plistPath, blueBubblesLaunchAgentPlist(), { mode: 0o644 })
}

function reloadNativeService(deps: BlueBubblesHostDeps, plistPath: string, wasLoaded: boolean): void {
  const target = serviceTarget(deps)
  const domain = launchdDomain(deps)
  if (wasLoaded) requireLaunchctl(deps.launchctl(["bootout", target]), "bootout")
  requireLaunchctl(deps.launchctl(["disable", target]), "disable")
  requireLaunchctl(deps.launchctl(["enable", target]), "enable")
  requireLaunchctl(deps.launchctl(["bootstrap", domain, plistPath]), "bootstrap")
}

export async function runBlueBubblesHostAction(
  action: BlueBubblesHostAction,
  deps: BlueBubblesHostDeps,
): Promise<BlueBubblesHostActionResult> {
  requireMacOS(deps)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bluebubbles_host_action_start",
    message: "starting native BlueBubbles host lifecycle action",
    meta: { action, uid: deps.uid },
  })
  try {
    const before = await inspectBlueBubblesHost(deps)
    let changed = false

    if (action === "status") {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.bluebubbles_host_action_end",
        message: "completed native BlueBubbles host lifecycle action",
        meta: { action, changed: false, service: before.service },
      })
      return { action, changed: false, state: before }
    }

    if (action === "remove") {
      if (before.service === "loaded") {
        requireLaunchctl(deps.launchctl(["disable", serviceTarget(deps)]), "disable")
        requireLaunchctl(deps.launchctl(["bootout", serviceTarget(deps)]), "bootout")
        changed = true
      }
      if (before.plist !== "missing") {
        deps.unlinkSync(before.plistPath)
        changed = true
      }
      const state = changed ? await inspectBlueBubblesHost(deps) : before
      emitNervesEvent({
        component: "daemon",
        event: "daemon.bluebubbles_host_action_end",
        message: "completed native BlueBubbles host lifecycle action",
        meta: { action, changed, service: state.service },
      })
      return { action, changed, state }
    }

    if (before.app === "missing") {
      throw new Error(`BlueBubbles app is missing at ${BLUEBUBBLES_APP_PATH}`)
    }

    const needsPlist = before.plist !== "current"
    if (needsPlist) {
      writeNativePlist(deps, before.plistPath)
      changed = true
    }
    if (needsPlist || before.service !== "loaded") {
      reloadNativeService(deps, before.plistPath, before.service === "loaded")
      changed = true
    }

    const state = changed ? await inspectBlueBubblesHost(deps) : before
    emitNervesEvent({
      component: "daemon",
      event: "daemon.bluebubbles_host_action_end",
      message: "completed native BlueBubbles host lifecycle action",
      meta: { action, changed, service: state.service },
    })
    return { action, changed, state }
  } catch (error) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.bluebubbles_host_action_error",
      level: "error",
      message: "native BlueBubbles host lifecycle action failed",
      meta: { action, uid: deps.uid, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

export function createDefaultBlueBubblesHostDeps(input: {
  probeHttp?: BlueBubblesHostDeps["probeHttp"]
} = {}): BlueBubblesHostDeps {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    uid: process.getuid?.() ?? 0,
    existsSync: fs.existsSync,
    readFileSync: (filePath) => fs.readFileSync(filePath, "utf8"),
    mkdirSync: fs.mkdirSync,
    writeFileSync: (filePath, content, options) => fs.writeFileSync(filePath, content, options),
    unlinkSync: fs.unlinkSync,
    launchctl: (args) => {
      try {
        const stdout = execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        return { ok: true, detail: stdout.trim() || "ok" }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { ok: false, detail }
      }
    },
    isProcessRunning: () => {
      try {
        execFileSync("pgrep", ["-f", BLUEBUBBLES_EXECUTABLE_PATH], { stdio: "ignore" })
        return true
      } catch {
        return false
      }
    },
    ...(input.probeHttp ? { probeHttp: input.probeHttp } : {}),
  }
}

export * from "./bluebubbles-host-protocol"
