import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { TaskStatus } from "../repertoire/tasks/types"
import { validateTransition } from "../repertoire/tasks/transitions"
import { generateTimestampId, readJsonDir, readJsonFile, writeJsonFile } from "./json-store"

export type PonderPacketKind = "harness_friction" | "research" | "reflection"
export type PonderPacketSop = "harness_friction_v1" | "research_v1" | "reflection_v1"

export interface PonderPacketOrigin {
  friendId: string
  channel: string
  key: string
}

export interface PonderPacket {
  id: string
  kind: PonderPacketKind
  sop: PonderPacketSop
  status: TaskStatus
  objective: string
  summary: string
  successCriteria: string[]
  origin?: PonderPacketOrigin
  relatedObligationId?: string
  relatedReturnObligationId?: string
  followsPacketId?: string
  payload: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface CreatePonderPacketInput {
  kind: PonderPacketKind
  objective: string
  summary: string
  successCriteria: string[]
  origin?: PonderPacketOrigin
  relatedObligationId?: string
  relatedReturnObligationId?: string
  followsPacketId?: string
  payload: Record<string, unknown>
}

interface RevisePonderPacketInput {
  kind: PonderPacketKind
  objective: string
  summary: string
  successCriteria: string[]
  payload: Record<string, unknown>
}

function packetsDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "packets")
}

export function getPonderPacketArtifactsDir(agentRoot: string, packetId: string): string {
  return path.join(agentRoot, "state", "packets", packetId)
}

function packetSop(kind: PonderPacketKind): PonderPacketSop {
  switch (kind) {
    case "harness_friction":
      return "harness_friction_v1"
    case "research":
      return "research_v1"
    case "reflection":
      return "reflection_v1"
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "drafting"
    || value === "processing"
    || value === "validating"
    || value === "collaborating"
    || value === "paused"
    || value === "blocked"
    || value === "done"
    || value === "cancelled"
}

function isPacketKind(value: unknown): value is PonderPacketKind {
  return value === "harness_friction" || value === "research" || value === "reflection"
}

function isPonderPacket(value: unknown): value is PonderPacket {
  if (!value || typeof value !== "object") return false
  const packet = value as Partial<PonderPacket>
  return typeof packet.id === "string"
    && isPacketKind(packet.kind)
    && typeof packet.objective === "string"
    && typeof packet.summary === "string"
    && Array.isArray(packet.successCriteria)
    && isTaskStatus(packet.status)
    && typeof packet.createdAt === "number"
    && typeof packet.updatedAt === "number"
}

export function listPonderPackets(agentRoot: string): PonderPacket[] {
  return readJsonDir<PonderPacket>(packetsDir(agentRoot))
    .filter(isPonderPacket)
    .sort((left, right) => left.createdAt - right.createdAt)
}

export function readPonderPacket(agentRoot: string, packetId: string): PonderPacket | null {
  const packet = readJsonFile<PonderPacket>(packetsDir(agentRoot), packetId)
  return isPonderPacket(packet) ? packet : null
}

export function createPonderPacket(agentRoot: string, input: CreatePonderPacketInput): PonderPacket {
  const now = Date.now()
  const packet: PonderPacket = {
    id: generateTimestampId("pkt"),
    kind: input.kind,
    sop: packetSop(input.kind),
    status: "drafting",
    objective: input.objective,
    summary: input.summary,
    successCriteria: input.successCriteria,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.relatedObligationId ? { relatedObligationId: input.relatedObligationId } : {}),
    ...(input.relatedReturnObligationId ? { relatedReturnObligationId: input.relatedReturnObligationId } : {}),
    ...(input.followsPacketId ? { followsPacketId: input.followsPacketId } : {}),
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  }
  writeJsonFile(packetsDir(agentRoot), packet.id, packet)

  emitNervesEvent({
    component: "mind",
    event: "mind.packet_created",
    message: "ponder packet created",
    meta: { packetId: packet.id, kind: packet.kind, status: packet.status },
  })

  return packet
}

export function revisePonderPacket(
  agentRoot: string,
  packetId: string,
  input: RevisePonderPacketInput,
): PonderPacket {
  const existing = readPonderPacket(agentRoot, packetId)
  if (!existing) {
    throw new Error(`packet not found: ${packetId}`)
  }
  if (existing.status !== "drafting") {
    throw new Error("packet is no longer drafting; file a follow-up packet instead")
  }

  const revised: PonderPacket = {
    ...existing,
    kind: input.kind,
    sop: packetSop(input.kind),
    objective: input.objective,
    summary: input.summary,
    successCriteria: input.successCriteria,
    payload: input.payload,
    updatedAt: Date.now(),
  }
  writeJsonFile(packetsDir(agentRoot), packetId, revised)

  emitNervesEvent({
    component: "mind",
    event: "mind.packet_revised",
    message: "ponder packet revised",
    meta: { packetId, kind: revised.kind, status: revised.status },
  })

  return revised
}

export function advancePonderPacket(
  agentRoot: string,
  packetId: string,
  update: {
    status?: TaskStatus
    relatedObligationId?: string
    relatedReturnObligationId?: string
  },
): PonderPacket {
  const existing = readPonderPacket(agentRoot, packetId)
  if (!existing) {
    throw new Error(`packet not found: ${packetId}`)
  }

  const nextStatus = update.status ?? existing.status
  if (update.status) {
    const transition = validateTransition(existing.status, update.status)
    if (!transition.ok) {
      throw new Error(transition.reason)
    }
  }

  const advanced: PonderPacket = {
    ...existing,
    status: nextStatus,
    ...(update.relatedObligationId ? { relatedObligationId: update.relatedObligationId } : {}),
    ...(update.relatedReturnObligationId ? { relatedReturnObligationId: update.relatedReturnObligationId } : {}),
    updatedAt: Date.now(),
  }
  writeJsonFile(packetsDir(agentRoot), packetId, advanced)

  emitNervesEvent({
    component: "mind",
    event: "mind.packet_advanced",
    message: "ponder packet advanced",
    meta: { packetId, status: advanced.status },
  })

  return advanced
}

export function findHarnessFrictionPacket(
  agentRoot: string,
  origin: PonderPacketOrigin,
  frictionSignature: string,
): PonderPacket | null {
  const found = listPonderPackets(agentRoot).find((packet) => {
    if (packet.kind !== "harness_friction") return false
    if (!packet.origin) return false
    return packet.origin.friendId === origin.friendId
      && packet.origin.channel === origin.channel
      && packet.origin.key === origin.key
      && packet.payload.frictionSignature === frictionSignature
  }) ?? null

  emitNervesEvent({
    component: "mind",
    event: "mind.packet_lookup",
    message: "ponder packet lookup completed",
    meta: {
      kind: "harness_friction",
      found: found !== null,
      origin: `${origin.friendId}/${origin.channel}/${origin.key}`,
      frictionSignature,
    },
  })

  return found
}
