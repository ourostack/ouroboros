import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { emitNervesEvent } from "../nerves/runtime"

export type TempoMode = "brief" | "standard" | "dense" | "crisis"
export type PresenceAvailability = "active" | "idle" | "away" | "dnd"
export type PresenceLane = "coding" | "conversation" | "mixed" | "idle"

export interface AgentPresence {
  agentName: string
  availability: PresenceAvailability
  lane: PresenceLane
  mission: string
  tempo: TempoMode
  updatedAt: string
}

export interface PresenceInputs {
  activeSessions: number
  openObligations: number
  activeBridges: number
  codingLanes: number
  currentTempo: TempoMode
}

function presenceDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "presence")
}

function deriveAvailability(inputs: PresenceInputs): PresenceAvailability {
  if (inputs.currentTempo === "crisis") return "dnd"
  if (inputs.activeSessions > 0) return "active"
  if (inputs.openObligations > 0) return "idle"
  return "away"
}

function deriveLane(inputs: PresenceInputs): PresenceLane {
  const hasCoding = inputs.codingLanes > 0
  const hasBridges = inputs.activeBridges > 0
  if (hasCoding && hasBridges) return "mixed"
  if (hasCoding) return "coding"
  if (hasBridges) return "conversation"
  return "idle"
}

function deriveMission(inputs: PresenceInputs): string {
  const parts: string[] = []
  if (inputs.openObligations > 0) {
    parts.push(`${inputs.openObligations} open obligation${inputs.openObligations !== 1 ? "s" : ""}`)
  }
  if (inputs.activeBridges > 0) {
    parts.push(`${inputs.activeBridges} active bridge${inputs.activeBridges !== 1 ? "s" : ""}`)
  }
  if (inputs.codingLanes > 0) {
    parts.push(`${inputs.codingLanes} coding lane${inputs.codingLanes !== 1 ? "s" : ""}`)
  }
  if (parts.length === 0) return "no active work"
  return parts.join(", ")
}

export function derivePresence(
  _agentRoot: string,
  agentName: string,
  inputs: PresenceInputs,
): AgentPresence {
  const presence: AgentPresence = {
    agentName,
    availability: deriveAvailability(inputs),
    lane: deriveLane(inputs),
    mission: deriveMission(inputs),
    tempo: inputs.currentTempo,
    updatedAt: new Date().toISOString(),
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.presence_derived",
    message: `presence derived: ${presence.availability}/${presence.lane}`,
    meta: {
      agentName,
      availability: presence.availability,
      lane: presence.lane,
      tempo: presence.tempo,
    },
  })

  return presence
}

export function writePresence(agentRoot: string, _agentName: string, presence: AgentPresence): void {
  const dir = presenceDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "self.json"), JSON.stringify(presence, null, 2), "utf-8")

  emitNervesEvent({
    component: "heart",
    event: "heart.presence_written",
    message: `presence written for ${presence.agentName}`,
    meta: { agentName: presence.agentName },
  })
}

export function readPresence(agentRoot: string, _agentName: string): AgentPresence | null {
  const filePath = path.join(presenceDir(agentRoot), "self.json")
  if (!fs.existsSync(filePath)) {
    emitNervesEvent({
      component: "heart",
      event: "heart.presence_read",
      message: "presence file not found",
      meta: { found: false },
    })
    return null
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const presence = JSON.parse(raw) as AgentPresence

    emitNervesEvent({
      component: "heart",
      event: "heart.presence_read",
      message: `presence read: ${presence.availability}`,
      meta: { agentName: presence.agentName, found: true },
    })

    return presence
  } catch {
    emitNervesEvent({
      component: "heart",
      event: "heart.presence_read_error",
      message: "failed to read presence file",
      meta: { error: "parse error" },
    })
    return null
  }
}

export function readPeerPresence(agentRoot: string): AgentPresence[] {
  const relDir = path.join(agentRoot, "state", "relationships")
  if (!fs.existsSync(relDir)) {
    emitNervesEvent({
      component: "heart",
      event: "heart.peer_presence_read",
      message: "no relationships directory, no peers",
      meta: { peerCount: 0 },
    })
    return []
  }

  const files = fs.readdirSync(relDir).filter((f) => f.endsWith(".json"))
  const peers: AgentPresence[] = []

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(relDir, file), "utf-8")
      const rel = JSON.parse(raw) as { agentName: string }
      const peerName = rel.agentName

      // Read peer's presence from their bundle
      const peerRoot = path.join(os.homedir(), "AgentBundles", `${peerName}.ouro`)
      const peerPresencePath = path.join(peerRoot, "state", "presence", "self.json")

      if (fs.existsSync(peerPresencePath)) {
        const presenceRaw = fs.readFileSync(peerPresencePath, "utf-8")
        const presence = JSON.parse(presenceRaw) as AgentPresence
        peers.push(presence)
      }
    } catch {
      // Skip peers with unreadable data
    }
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.peer_presence_read",
    message: `read ${peers.length} peer presence records`,
    meta: { peerCount: peers.length },
  })

  return peers
}
