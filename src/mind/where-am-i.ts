/**
 * `## where i am`: which machine this presence runs on, its peers, and which
 * shared senses it owns, so an agent present on several machines always
 * knows where it is and who else it is.
 */

import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { readMachineIdentity } from "../heart/machine-identity"
import { describeOs } from "../heart/daemon/presence-daemon"
import {
  SHARED_SENSES,
  effectiveOwner,
  enabledSharedSenses,
  isRosterMember,
  senseEnabled,
  readLocalPresenceSettings,
  readPresenceForAgent,
  rosterMachine,
  type PeerRecord,
  type Presence,
} from "../heart/daemon/presence"

export interface MachineInfo {
  machineId: string
  name: string
  role: string
  os: string
  location: string
}

function ago(seenAt: string, nowMs: number): string {
  const ms = nowMs - Date.parse(seenAt)
  if (!Number.isFinite(ms)) return "at an unknown time"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

function sessionCounts(record: PeerRecord | undefined): string {
  const counts = record?.appSessions?.counts
  if (!counts) return ""
  const parts = Object.entries(counts).filter(([, count]) => typeof count === "number").map(([state, count]) => `${count} ${state}`)
  return parts.length > 0 ? `; copilot app sessions: ${parts.join(", ")}` : ""
}

/** Senses every presence runs for its own machine. */
const MACHINE_SENSES = ["cli", "shepherd", "app-sessions"]
/** What a person calls a sense whose name is the integration's. */
const SENSE_NAMES: Record<string, string> = { bluebubbles: "bluebubbles (iMessage)" }

export function renderWhereAmI(presence: Presence | null, self: MachineInfo, nowMs: number = Date.now()): string {
  if (!presence) return ""
  const machineName = (id: string): string => rosterMachine(presence, id)?.name ?? id
  const peers = presence.block.machines.filter((machine) => machine.machineId !== self.machineId)
  const lines = [
    "## where i am",
    `i am on ${self.name} (${self.role}), ${self.os}, at ${self.location}. i am one named agent present on ${presence.block.machines.length} machine${presence.block.machines.length === 1 ? "" : "s"}; each presence runs on its own machine and we share this bundle through git.`,
  ]
  if (peers.length === 0) {
    lines.push("my peers: none; this is my only presence.")
  } else {
    lines.push("my peers:")
    for (const peer of peers) {
      const record = presence.peers.find((candidate) => candidate.machineId === peer.machineId)
      const facts = [peer.role, record?.os, record?.location].filter(Boolean).join(", ")
      const seen = record ? `last seen ${ago(record.seenAt, nowMs)} on ${record.version}${sessionCounts(record)}` : "not seen yet (no presence record)"
      lines.push(`- ${peer.name} (${facts}): ${seen}`)
    }
  }
  // Only senses agent.json turns on: a disabled sense runs on no machine, whatever the roster's owners say.
  const enabled = enabledSharedSenses(presence)
  const own = enabled.filter((sense) => effectiveOwner(presence, sense) === self.machineId)
  const standIn = (presence.failover ?? []).filter((lease) => lease.machine === self.machineId)
  const elsewhere = enabled.filter((sense) => effectiveOwner(presence, sense) !== self.machineId && !standIn.some((lease) => lease.sense === sense))
  const here = own.map((sense) => {
    // The same wait mayRunSense applies: a peer whose record still runs it has not let go yet.
    const holder = presence.peers.find((peer) => peer.machineId !== self.machineId && isRosterMember(presence, peer.machineId) && peer.owns?.includes(sense) && !peer.failover?.includes(sense))
    return holder ? `${sense} (not yet: waiting for ${machineName(holder.machineId)} to let go)` : sense
  })
  lines.push(`shared senses (each runs on exactly one machine) that run here, on ${self.name}: ${here.length > 0 ? here.join(", ") : "none"}.`)
  for (const lease of standIn) {
    lines.push(`i am running ${lease.sense} here in place of ${machineName(lease.from)} since ${ago(lease.since, nowMs)}, because ${lease.reason || "it stopped answering"}; ${machineName(lease.from)} takes it back as soon as it runs again.`)
  }
  if (elsewhere.length > 0) {
    lines.push(`shared senses that run on a peer, not here: ${elsewhere.map((sense) => {
      const owner = effectiveOwner(presence, sense)
      const record = presence.peers.find((peer) => peer.machineId === owner)
      const shown = record?.owns?.includes(sense) ? `its record from ${ago(record.seenAt, nowMs)} says it runs it` : "its last record does not show it running"
      return `${sense} (${machineName(owner)}; ${shown})`
    }).join(", ")}.`)
  }
  const off = SHARED_SENSES.filter((sense) => !senseEnabled(presence, sense)).map((sense) => SENSE_NAMES[sense] ?? sense)
  if (off.length > 0) lines.push(`turned off in agent.json, so running on no machine: ${off.join(", ")}.`)
  const local = MACHINE_SENSES.filter((sense) => senseEnabled(presence, sense))
  const localOff = MACHINE_SENSES.filter((sense) => !senseEnabled(presence, sense))
  lines.push(`machine-scoped senses that run on every presence and see only their own machine: ${local.length > 0 ? local.join(", ") : "none"}${localOff.length > 0 ? `; turned off in agent.json: ${localOff.join(", ")}` : ""}.`)
  if (presence.legacy.length > 0) {
    lines.push(`until ${presence.legacy.map((id) => machineName(id)).join(", ")} publish${presence.legacy.length === 1 ? "es" : ""} a current presence record, every shared sense stays with home.`)
  }
  return lines.join("\n")
}

/** The section for this turn, read from the bundle, the local flag and this machine's identity. */
export function whereAmISection(agentRoot: string, homeDir: string = os.homedir()): string {
  const presence = readPresenceForAgent(agentRoot, { homeDir })
  if (!presence) return ""
  const identity = readMachineIdentity(homeDir)
  if (!identity) return ""
  const machine = rosterMachine(presence, identity.machineId)
  if (!machine) return ""
  const settings = readLocalPresenceSettings(homeDir)
  const section = renderWhereAmI(presence, {
    machineId: identity.machineId,
    name: machine.name,
    role: machine.role,
    os: describeOs(),
    location: settings.location ?? (machine.role === "always-on" ? "home" : "an unknown location"),
  })
  emitNervesEvent({ component: "mind", event: "mind.where_am_i_rendered", message: "rendered where i am", meta: { agent: path.basename(agentRoot), machineId: identity.machineId } })
  return section
}
