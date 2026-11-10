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
  const own = SHARED_SENSES.filter((sense) => effectiveOwner(presence, sense) === self.machineId)
  const elsewhere = SHARED_SENSES.filter((sense) => effectiveOwner(presence, sense) !== self.machineId)
  lines.push(`shared senses i own here: ${own.length > 0 ? own.join(", ") : "none"}.`)
  if (elsewhere.length > 0) {
    lines.push(`owned by a peer: ${elsewhere.map((sense) => `${sense} (${machineName(effectiveOwner(presence, sense))})`).join(", ")}.`)
  }
  lines.push("machine-scoped senses (cli, shepherd, app-sessions) run on every presence and see only their own machine.")
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
