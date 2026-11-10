/**
 * Roster changes in the synced agent.json, published by the same
 * compare-and-swap `ouro move` uses (agent-home.ts):
 *
 * - `ouro presence join` adds this machine to the agent's roster;
 * - `ouro presence handoff <sense> <machine>` names a shared sense's owner;
 * - `ouro presence status` shows the roster as this machine sees it.
 */

import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseAgentHome } from "./agent-discovery"
import { updateSyncedAgentJson, type MoveAgentHomeResult, type MoveNetwork } from "./agent-home"
import {
  SHARED_SENSES,
  effectiveOwner,
  findRosterMachine,
  isSharedSense,
  parsePresenceBlock,
  readPeerRecords,
  readPresence,
  type PeerRecord,
  type Presence,
  type PresenceBlock,
} from "./presence"

type GitExec = (command: string, args: string[], options: { cwd: string; stdio: "pipe"; timeout: number }) => Buffer | string

interface RosterCommandBase {
  agent: string
  bundlesRoot: string
  execFileSync?: GitExec
  lockWaitMs?: number
  network?: MoveNetwork
}

export interface JoinRosterOptions extends RosterCommandBase {
  machineId: string
  machineName: string
  role: string
  /** The oldest harness version that knows presence; recorded when the roster is created. */
  minVersion: string
}

/** Add (or rename) this machine in the agent's roster. Creating a roster keeps every shared sense with `home`. */
export async function joinPresenceRoster(options: JoinRosterOptions): Promise<MoveAgentHomeResult> {
  const { agent, machineId, machineName, role } = options
  return updateSyncedAgentJson({
    agent,
    bundlesRoot: options.bundlesRoot,
    retryCommand: `ouro presence join --agent ${agent}`,
    events: "daemon.presence_join",
    meta: { machineId },
    noun: "join",
    verb: "add this machine to",
    execFileSync: options.execFileSync,
    lockWaitMs: options.lockWaitMs,
    network: options.network,
    stamp: (parsed) => JSON.stringify(parsed.presence ?? null),
    lostRace: () => ({ field: "presence roster", now: "run `ouro presence status` to see it" }),
    decide: (parsed) => {
      const existing = parsePresenceBlock(parsed.presence)
      const block: PresenceBlock = existing ?? { schema: 1, minVersion: options.minVersion, machines: [], owners: {} }
      const current = block.machines.find((machine) => machine.machineId === machineId)
      if (current && current.name === machineName && current.role === role) {
        return { kind: "noop", message: `${machineName} is already on ${agent}'s roster as ${role}` }
      }
      const machines = current
        ? block.machines.map((machine) => (machine.machineId === machineId ? { machineId, name: machineName, role } : machine))
        : [...block.machines, { machineId, name: machineName, role }]
      const owners = { ...block.owners }
      if (!existing) {
        const ownerId = parseAgentHome(parsed.home)?.machineId ?? machineId
        for (const sense of SHARED_SENSES) owners[sense] = ownerId
      }
      const next: PresenceBlock = { ...block, machines, owners }
      return {
        kind: "write",
        next: { ...parsed, presence: next },
        commitMessage: `presence: ${machineName} joins ${agent}`,
        message: `${machineName} (${role}) is on ${agent}'s roster with ${machines.filter((machine) => machine.machineId !== machineId).map((machine) => machine.name).join(", ") || "no other machine"}`,
      }
    },
  })
}

export interface HandoffSenseOptions extends RosterCommandBase {
  sense: string
  /** The new owner's roster name or machine id. */
  target: string
}

/**
 * Name a shared sense's owner. Refused while any roster machine may still run
 * a daemon that knows only `home`, because that daemon would run the sense too.
 */
export async function handoffPresenceSense(options: HandoffSenseOptions): Promise<MoveAgentHomeResult> {
  const { agent, sense, target } = options
  const agentRoot = path.join(options.bundlesRoot, `${agent}.ouro`)
  return updateSyncedAgentJson({
    agent,
    bundlesRoot: options.bundlesRoot,
    retryCommand: `ouro presence handoff ${sense} ${target} --agent ${agent}`,
    events: "daemon.presence_handoff",
    meta: { sense, target },
    noun: "handoff",
    verb: "hand off a sense of",
    execFileSync: options.execFileSync,
    lockWaitMs: options.lockWaitMs,
    network: options.network,
    stamp: (parsed) => JSON.stringify(parsePresenceBlock(parsed.presence)?.owners[sense] ?? null),
    lostRace: (parsed) => {
      const block = parsePresenceBlock(parsed.presence)
      const owner = block?.owners[sense]
      const name = owner ? block?.machines.find((machine) => machine.machineId === owner)?.name ?? owner : "no machine"
      return { field: `${sense} owner`, now: `it now names ${name}` }
    },
    decide: (parsed) => {
      if (!isSharedSense(sense)) {
        return { kind: "refuse", message: `${sense} runs on every machine in the roster, so it has no owner to hand off; shared senses are ${SHARED_SENSES.join(", ")}` }
      }
      const presence = readPresence(parsed, true, readPeerRecords(agentRoot))
      if (!presence) {
        return { kind: "refuse", message: `${agent} has no presence roster, so nothing changed; run \`ouro presence join --agent ${agent}\` on each machine first` }
      }
      const machine = findRosterMachine(presence, target)
      if (!machine) {
        return { kind: "refuse", message: `${target} is not on ${agent}'s roster (${presence.block.machines.map((entry) => entry.name).join(", ")}), so nothing changed` }
      }
      if (presence.legacy.length > 0) {
        const names = presence.legacy.map((id) => presence.block.machines.find((entry) => entry.machineId === id)?.name ?? id)
        return {
          kind: "refuse",
          message: `${names.join(", ")} may still run a daemon that only knows \`home\` (no current presence record${presence.block.minVersion ? ` at ${presence.block.minVersion} or later` : ""}), so every shared sense stays with home and nothing changed; start a presence-aware daemon there first`,
        }
      }
      if (presence.block.owners[sense] === machine.machineId) {
        return { kind: "noop", message: `${machine.name} already owns ${agent}'s ${sense}` }
      }
      const previous = effectiveOwner(presence, sense)
      const previousName = presence.block.machines.find((entry) => entry.machineId === previous)?.name ?? previous
      return {
        kind: "write",
        next: { ...parsed, presence: { ...(parsed.presence as Record<string, unknown>), owners: { ...presence.block.owners, [sense]: machine.machineId } } },
        commitMessage: `presence: ${agent}'s ${sense} moves to ${machine.name}`,
        message: `${machine.name} now owns ${agent}'s ${sense} (from ${previousName}); ${previousName} stops it and ${machine.name} starts it within about a minute of each pulling the change`,
      }
    },
  })
}

/** `ouro presence status --json`: this machine, its peers and what it owns, for tools such as an arrival check. */
export function presenceStatusJson(options: { presence: Presence | null; machineId: string; settings: { enabled: boolean; location?: string } }): {
  enabled: boolean
  machine: { machineId: string; name: string | null; role: string | null; location: string | null } | null
  peers: Array<{ machineId: string; name: string; role: string; seenAt: string | null; version: string | null; location: string | null }>
  owns: string[]
  owners: Record<string, string | null>
  legacy: string[]
} {
  const { presence, machineId, settings } = options
  emitNervesEvent({ component: "daemon", event: "daemon.presence_status_json", message: "rendered presence status as json", meta: { active: presence !== null } })
  if (!presence) return { enabled: settings.enabled, machine: null, peers: [], owns: [], owners: {}, legacy: [] }
  const me = presence.block.machines.find((machine) => machine.machineId === machineId)
  const owners: Record<string, string | null> = {}
  for (const sense of SHARED_SENSES) {
    const owner = effectiveOwner(presence, sense)
    owners[sense] = presence.block.machines.find((machine) => machine.machineId === owner)?.name ?? owner
  }
  return {
    enabled: settings.enabled,
    machine: me
      ? { machineId, name: me.name, role: me.role, location: settings.location ?? (me.role === "always-on" ? "home" : null) }
      : { machineId, name: null, role: null, location: settings.location ?? null },
    peers: presence.block.machines.filter((machine) => machine.machineId !== machineId).map((machine) => {
      const record = presence.peers.find((peer) => peer.machineId === machine.machineId)
      return { machineId: machine.machineId, name: machine.name, role: machine.role, seenAt: record?.seenAt ?? null, version: record?.version ?? null, location: record?.location ?? null }
    }),
    owns: SHARED_SENSES.filter((sense) => effectiveOwner(presence, sense) === machineId),
    owners,
    legacy: presence.legacy.map((id) => presence.block.machines.find((machine) => machine.machineId === id)?.name ?? id),
  }
}

function ago(seenAt: string, now: Date): string {
  const ms = now.getTime() - Date.parse(seenAt)
  if (!Number.isFinite(ms)) return "unknown"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/** A person-readable view of the roster as this machine sees it. */
export function renderPresenceStatus(options: {
  agent: string
  presence: Presence | null
  flagEnabled: boolean
  machineId: string
  now?: Date
}): string {
  const { agent, presence, machineId } = options
  const now = options.now ?? new Date()
  emitNervesEvent({ component: "daemon", event: "daemon.presence_status_rendered", message: "rendered presence status", meta: { agent, active: presence !== null } })
  if (!options.flagEnabled) return `presence is off on this machine, so ${agent} follows its home lease here; turn it on with \`ouro presence join --agent ${agent}\``
  if (!presence) return `${agent} has no presence roster, so it follows its home lease; run \`ouro presence join --agent ${agent}\` on each machine`
  const lines = [`${agent} is present on ${presence.block.machines.length} machine${presence.block.machines.length === 1 ? "" : "s"}:`]
  for (const machine of presence.block.machines) {
    const record: PeerRecord | undefined = presence.peers.find((peer) => peer.machineId === machine.machineId)
    const me = machine.machineId === machineId ? " (this machine)" : ""
    const seen = record ? `${record.version}, seen ${ago(record.seenAt, now)}` : "no presence record yet"
    const legacy = presence.legacy.includes(machine.machineId) ? "; may run a home-only daemon" : ""
    lines.push(`- ${machine.name}${me}: ${machine.role}; ${seen}${legacy}`)
  }
  lines.push("owners:")
  for (const sense of SHARED_SENSES) {
    const owner = effectiveOwner(presence, sense)
    const name = presence.block.machines.find((machine) => machine.machineId === owner)?.name ?? owner
    const declared = presence.block.owners[sense]
    const held = declared && declared !== owner ? ` (roster names ${presence.block.machines.find((machine) => machine.machineId === declared)?.name ?? declared}; held by home until every machine runs presence)` : ""
    lines.push(`- ${sense}: ${name}${held}`)
  }
  return lines.join("\n")
}
