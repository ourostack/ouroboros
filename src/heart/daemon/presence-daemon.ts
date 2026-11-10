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

import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  emitOwnershipChange,
  effectiveOwner,
  ownedSharedSenses,
  ownsSense,
  readLocalPresenceSettings,
  readPresenceForAgent,
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
}

export class PresenceTicker {
  private readonly lastPublishedMs = new Map<string, number>()
  /** Agents whose schedulers this machine holds back because another machine owns `habits`. */
  private readonly held = new Set<string>()

  constructor(private readonly deps: PresenceTickDeps) {}

  /** At daemon start: whether to start this agent's schedulers now. */
  shouldStartSchedulers(agent: string): boolean {
    const presence = this.read(agent)
    if (!presence || ownsSense(presence, this.deps.machineId, "habits")) return true
    this.held.add(agent)
    emitOwnershipChange(agent, "habits", false, effectiveOwner(presence, "habits"))
    return false
  }

  async tick(): Promise<void> {
    for (const agent of this.deps.agents) {
      if (!this.read(agent)) continue
      try {
        await this.deps.sync?.(agent, path.join(this.deps.bundlesRoot, `${agent}.ouro`))
        const presence = this.read(agent)
        if (!presence) continue
        this.reconcileSchedulers(agent, presence)
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

  private read(agent: string): Presence | null {
    const agentRoot = path.join(this.deps.bundlesRoot, `${agent}.ouro`)
    /* v8 ignore next -- production default reads the bundle; tests inject readPresence @preserve */
    return this.deps.readPresence ? this.deps.readPresence(agentRoot) : readPresenceForAgent(agentRoot, { homeDir: this.deps.homeDir })
  }

  private reconcileSchedulers(agent: string, presence: Presence): void {
    const owns = ownsSense(presence, this.deps.machineId, "habits")
    const running = this.deps.schedulersRunning(agent)
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
    const last = this.lastPublishedMs.get(agent)
    if (last !== undefined && now.getTime() - last < PEER_RECORD_INTERVAL_MS) return
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
      owns: ownedSharedSenses(presence, this.deps.machineId),
      ...this.deps.extraRecord?.(agent),
    }
    writePeerRecord(agentRoot, record)
    this.lastPublishedMs.set(agent, now.getTime())
    emitNervesEvent({ component: "daemon", event: "daemon.presence_record_published", message: "published this machine's presence record", meta: { agent, machineId: this.deps.machineId, version: this.deps.version } })
  }
}
