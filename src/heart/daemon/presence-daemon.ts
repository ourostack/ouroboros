/**
 * The daemon's per-minute presence work, for agents whose roster names this
 * machine:
 *
 * - publish this machine's record (`presence/<machineId>.json`: version,
 *   last seen, name, role, OS, location, owned senses) every 15 minutes, and
 *   push it, so each peer can tell this presence is alive and up to date;
 * - start the habit and await schedulers when this machine owns `habits`,
 *   and stop them when another machine does.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  emitOwnershipChange,
  effectiveOwner,
  mayRunSense,
  ownedSharedSenses,
  failoverSenses,
  ownsSense,
  readLocalPresenceSettings,
  readPresenceForAgent,
  writeLocalPresenceSettings,
  rosterMachine,
  writePeerRecord,
  type PeerRecord,
  type Presence,
} from "./presence"

export const PEER_RECORD_INTERVAL_MS = 15 * 60_000

export function describeOs(platform: NodeJS.Platform = process.platform, release: string = os.release()): string {
  if (platform === "darwin") {
    const major = Number(release.split(".")[0])
    // Darwin 25 is macOS 26, Darwin 24 is macOS 15, Darwin 20 is macOS 11.
    const macos = major >= 25 ? major + 1 : major >= 20 ? major - 9 : null
    return macos ? `macOS ${macos}` : `macOS (Darwin ${release})`
  }
  if (platform === "linux") return `Linux ${release}`
  if (platform === "win32") return `Windows ${release}`
  return `${platform} ${release}`
}

export interface PresenceTickDeps {
  agents: readonly string[]
  bundlesRoot: string
  machineId: string
  version: string
  homeDir?: string
  now?: () => Date
  readPresence?: (agentRoot: string) => Presence | null
  /** Pull and push the bundle each minute, so handoffs and peer records travel; failures only delay them. */
  sync?: (agent: string, agentRoot: string) => Promise<void>
  startSchedulers: (agent: string) => void
  stopSchedulers: (agent: string) => void
  schedulersRunning: (agent: string) => boolean
  /** Extra record fields (e.g. the app-sessions snapshot). */
  extraRecord?: (agent: string) => Partial<PeerRecord>
  /** Run a command; resolves with its stdout. Defaults to execFile. */
  run?: (argv: string[], timeoutMs: number) => Promise<string>
  /** Hand the agent something to tell its owner (queued message plus a wake). */
  notify?: (agent: string, text: string) => Promise<void>
}

/* v8 ignore start -- production default: a real child process; tests inject run @preserve */
function runCommand(argv: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}
/* v8 ignore stop */

/** A location from a command's output: JSON `{ "location": … }`, or its first line. */
export function parseLocationOutput(stdout: string): string | null {
  const textOut = stdout.trim()
  if (!textOut) return null
  try {
    const parsed = JSON.parse(textOut) as { location?: unknown }
    return typeof parsed.location === "string" && parsed.location.trim() ? parsed.location.trim() : null
  } catch {
    const line = textOut.split("\n")[0]!.trim()
    return /^[\w .-]{1,40}$/.test(line) ? line : null
  }
}

/** What an arrival command printed, for the agent to pass on: JSON `.teams` or `.text`, else the raw text. */
export function arrivalText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { teams?: unknown; text?: unknown }
    if (typeof parsed.teams === "string" && parsed.teams.trim()) return parsed.teams.trim()
    if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim()
  } catch {
    // Plain text.
  }
  return stdout.trim()
}

export class PresenceTicker {
  private readonly lastPublishedMs = new Map<string, number>()
  /** What each agent's last record said this machine owns; a change publishes at once. */
  private readonly lastOwns = new Map<string, string>()
  /** Agents whose schedulers this machine holds back because another machine owns `habits`. */
  private readonly held = new Set<string>()

  constructor(private readonly deps: PresenceTickDeps) {}

  /** At daemon start: whether to start this agent's schedulers now. */
  shouldStartSchedulers(agent: string): boolean {
    const presence = this.read(agent)
    if (!presence || mayRunSense(presence, this.deps.machineId, "habits")) return true
    this.held.add(agent)
    emitOwnershipChange(agent, "habits", false, effectiveOwner(presence, "habits"))
    return false
  }

  async tick(): Promise<void> {
    const arrived = await this.refreshLocation()
    for (const agent of this.deps.agents) {
      if (!this.read(agent)) {
        // The roster is gone: back to the home lease, so run what was held. A flag turned off here keeps
        // holding until the daemon restarts, which publishes that this machine left first.
        if (readLocalPresenceSettings(this.deps.homeDir).enabled && this.held.delete(agent)) this.deps.startSchedulers(agent)
        continue
      }
      try {
        await this.deps.sync?.(agent, path.join(this.deps.bundlesRoot, `${agent}.ouro`))
        const presence = this.read(agent)
        if (!presence) continue
        this.reconcileSchedulers(agent, presence)
        if (arrived) await this.announceArrival(agent, presence, arrived)
        await this.publish(agent, presence)
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.presence_tick_error",
          message: "presence upkeep failed; retrying next minute",
          meta: { agent, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }

  /** Run the location command; returns the new location when it changed and an arrival command exists for it. */
  private async refreshLocation(): Promise<string | null> {
    const settings = readLocalPresenceSettings(this.deps.homeDir, {})
    if (!settings.locationCommand) return null
    let location: string | null
    try {
      location = parseLocationOutput(await (this.deps.run ?? runCommand)(settings.locationCommand, 15_000))
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.presence_location_error", message: "location command failed; keeping the last location", meta: { error: error instanceof Error ? error.message : String(error) } })
      return null
    }
    if (!location || location === settings.location) return null
    writeLocalPresenceSettings({ ...settings, location }, this.deps.homeDir)
    // Any record published from now on carries the new location.
    this.lastPublishedMs.clear()
    emitNervesEvent({ component: "daemon", event: "daemon.presence_location_changed", message: `this machine is now at ${location}`, meta: { from: settings.location ?? null, to: location } })
    return settings.onArrive?.[location] ? location : null
  }

  /** The first arrival at a location each day: run its command once (receipted) and hand the result to the agent. */
  private async announceArrival(agent: string, presence: Presence, location: string): Promise<void> {
    const settings = readLocalPresenceSettings(this.deps.homeDir, {})
    const command = settings.onArrive?.[location]
    if (!command || !rosterMachine(presence, this.deps.machineId)) return
    const now = (this.deps.now ?? (() => new Date()))()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    const key = `${this.deps.machineId}:${location}:${day}`
    const receiptPath = path.join(this.deps.bundlesRoot, `${agent}.ouro`, "state", "presence-arrivals.json")
    let receipts: Record<string, string> = {}
    try {
      receipts = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as Record<string, string>
    } catch {
      // No arrivals yet.
    }
    if (receipts[key]) return
    // The receipt comes first, so a crash or restart never announces twice.
    receipts[key] = now.toISOString()
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipts, null, 2)}\n`, "utf-8")
    const machine = rosterMachine(presence, this.deps.machineId)!
    let report: string
    try {
      report = arrivalText(await (this.deps.run ?? runCommand)(command, 120_000))
    } catch (error) {
      report = `the arrival check failed: ${error instanceof Error ? error.message : String(error)}`
    }
    emitNervesEvent({ component: "daemon", event: "daemon.presence_arrival", message: `arrived at ${location}`, meta: { agent, machine: machine.name, location } })
    await this.deps.notify?.(agent, `${machine.name} just arrived at ${location} for the first time today. Tell Ari on Teams now, once, with this arrival check as written:\n\n${report}`)
  }

  private read(agent: string): Presence | null {
    const agentRoot = path.join(this.deps.bundlesRoot, `${agent}.ouro`)
    /* v8 ignore next -- production default reads the bundle; tests inject readPresence @preserve */
    return this.deps.readPresence ? this.deps.readPresence(agentRoot) : readPresenceForAgent(agentRoot, { homeDir: this.deps.homeDir })
  }

  private reconcileSchedulers(agent: string, presence: Presence): void {
    const running = this.deps.schedulersRunning(agent)
    const owns = running ? ownsSense(presence, this.deps.machineId, "habits") : mayRunSense(presence, this.deps.machineId, "habits")
    if (owns && !running && this.held.has(agent)) {
      this.held.delete(agent)
      emitOwnershipChange(agent, "habits", true, this.deps.machineId)
      this.deps.startSchedulers(agent)
    } else if (!owns && running) {
      this.held.add(agent)
      emitOwnershipChange(agent, "habits", false, effectiveOwner(presence, "habits"))
      this.deps.stopSchedulers(agent)
    }
  }

  private async publish(agent: string, presence: Presence): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))()
    const owns = ownedSharedSenses(presence, this.deps.machineId)
    const failover = failoverSenses(presence, this.deps.machineId)
    const last = this.lastPublishedMs.get(agent)
    const ownsChanged = this.lastOwns.get(agent) !== [...owns, ...failover.map((sense) => `failover:${sense}`)].join(",")
    if (!ownsChanged && last !== undefined && now.getTime() - last < PEER_RECORD_INTERVAL_MS) return
    const agentRoot = path.join(this.deps.bundlesRoot, `${agent}.ouro`)
    const machine = rosterMachine(presence, this.deps.machineId)
    if (!machine) return
    const settings = readLocalPresenceSettings(this.deps.homeDir)
    const record: PeerRecord = {
      machineId: this.deps.machineId,
      version: this.deps.version,
      seenAt: now.toISOString(),
      name: machine.name,
      role: machine.role,
      os: describeOs(),
      location: settings.location ?? (machine.role === "always-on" ? "home" : "unknown"),
      owns,
      ...(failover.length > 0 ? { failover } : {}),
      ...this.deps.extraRecord?.(agent),
    }
    writePeerRecord(agentRoot, record)
    this.lastPublishedMs.set(agent, now.getTime())
    this.lastOwns.set(agent, [...owns, ...failover.map((sense) => `failover:${sense}`)].join(","))
    emitNervesEvent({ component: "daemon", event: "daemon.presence_record_published", message: "published this machine's presence record", meta: { agent, machineId: this.deps.machineId, version: this.deps.version } })
  }
}
