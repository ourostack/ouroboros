import * as path from "path"
import { capStructuredRecordString, capStructuredRecordStringArray, capStructuredRecordStringLeaves } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { isTaskStatus, type TaskStatus, validateTransition } from "./task-lifecycle"
import { generateTimestampId, readJsonDir, readJsonFile, writeJsonFile } from "./json-store"
import { isActiveReturnObligationRecord, readObligation, readReturnObligationForRoot } from "./obligations"
import {
  addEvolutionEvidence,
  appendEvolutionTraceEvent,
  createEvolutionCase,
  findOpenEvolutionCaseByFrictionSignature,
  type EvolutionEvidenceRef,
  type EvolutionOrigin,
} from "./evolution"

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

function packetLocator(packetId: string): string {
  return `arc/packets/${packetId}.json`
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

export const ACTIVE_PONDER_PACKET_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "drafting",
  "processing",
  "validating",
  "collaborating",
  "paused",
  "blocked",
])

export function isActivePonderPacketStatus(status: TaskStatus): boolean {
  return ACTIVE_PONDER_PACKET_STATUSES.has(status)
}

export interface ActivePonderPacketOptions {
  now?: () => number
}

function hasInactiveLinkedReturnObligation(
  agentRoot: string,
  packet: PonderPacket,
  options: ActivePonderPacketOptions = {},
): boolean {
  if (!packet.relatedReturnObligationId) return false
  const obligation = readReturnObligationForRoot(agentRoot, packet.relatedReturnObligationId)
  return !isActiveReturnObligationRecord(obligation, options)
}

function hasFulfilledLinkedObligation(agentRoot: string, packet: PonderPacket): boolean {
  if (!packet.relatedObligationId) return false
  const obligation = readObligation(agentRoot, packet.relatedObligationId)
  return obligation?.status === "fulfilled"
}

export function isActivePonderPacket(
  agentRoot: string,
  packet: PonderPacket,
  options: ActivePonderPacketOptions = {},
): boolean {
  return isActivePonderPacketStatus(packet.status)
    && !hasInactiveLinkedReturnObligation(agentRoot, packet, options)
    && !hasFulfilledLinkedObligation(agentRoot, packet)
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function evolutionOriginForPacket(packet: PonderPacket): EvolutionOrigin {
  if (packet.origin) {
    return {
      kind: "session",
      label: `${packet.origin.friendId}/${packet.origin.channel}/${packet.origin.key}`,
      locator: packetLocator(packet.id),
    }
  }
  return {
    kind: "runtime",
    label: "ponder packet",
    locator: packetLocator(packet.id),
  }
}

function desiredBehaviorForPacket(packet: PonderPacket): string {
  return packet.successCriteria.length > 0
    ? packet.successCriteria.join("; ")
    : "Resolve the captured harness friction."
}

function evidenceForPacket(packet: PonderPacket, reason: string): EvolutionEvidenceRef {
  return {
    kind: "ponder_packet",
    locator: packetLocator(packet.id),
    capturedAt: new Date(packet.createdAt).toISOString(),
    redaction: "summary",
    reason,
  }
}

function bindHarnessFrictionEvolutionCase(agentRoot: string, packet: PonderPacket): PonderPacket {
  if (packet.kind !== "harness_friction") return packet
  const frictionSignature = payloadString(packet.payload, "frictionSignature")
  if (!frictionSignature) return packet

  const existing = findOpenEvolutionCaseByFrictionSignature(agentRoot, frictionSignature)
  const evidenceReason = existing
    ? "Harness-friction ponder packet added evidence to this evolution case"
    : "Harness-friction ponder packet created this evolution case"
  const evidence = evidenceForPacket(packet, evidenceReason)
  const evolutionCase = existing
    ? addEvolutionEvidence(agentRoot, existing.id, evidence)
    : createEvolutionCase(agentRoot, {
      title: packet.objective,
      problemStatement: packet.summary,
      desiredBehavior: desiredBehaviorForPacket(packet),
      origin: evolutionOriginForPacket(packet),
      evidenceRefs: [evidence],
      frictionSignature,
      packetId: packet.id,
    })

  if (!existing) {
    appendEvolutionTraceEvent(agentRoot, evolutionCase.id, {
      type: "evidence_added",
      reason: evidence.reason,
      evidenceRefs: [evidence.locator],
    })
  }

  return {
    ...packet,
    payload: {
      ...packet.payload,
      evolutionCaseId: evolutionCase.id,
    },
  }
}

export function listPonderPackets(agentRoot: string): PonderPacket[] {
  return readJsonDir<PonderPacket>(packetsDir(agentRoot))
    .filter(isPonderPacket)
    .sort((left, right) => left.createdAt - right.createdAt)
}

export function listActivePonderPackets(
  agentRoot: string,
  options: ActivePonderPacketOptions = {},
): PonderPacket[] {
  return listPonderPackets(agentRoot).filter((packet) => isActivePonderPacket(agentRoot, packet, options))
}

export function readPonderPacket(agentRoot: string, packetId: string): PonderPacket | null {
  const packet = readJsonFile<PonderPacket>(packetsDir(agentRoot), packetId)
  return isPonderPacket(packet) ? packet : null
}

export function findPonderPacketByRelatedReturnObligationId(
  agentRoot: string,
  relatedReturnObligationId: string,
): PonderPacket | null {
  return listPonderPacketsByRelatedReturnObligationId(agentRoot, relatedReturnObligationId)[0] ?? null
}

export function listPonderPacketsByRelatedReturnObligationId(
  agentRoot: string,
  relatedReturnObligationId: string,
): PonderPacket[] {
  return listPonderPackets(agentRoot).filter((packet) => packet.relatedReturnObligationId === relatedReturnObligationId)
}

export function listPonderPacketsByRelatedObligationId(
  agentRoot: string,
  relatedObligationId: string,
): PonderPacket[] {
  return listPonderPackets(agentRoot).filter((packet) => packet.relatedObligationId === relatedObligationId)
}

export function createPonderPacket(agentRoot: string, input: CreatePonderPacketInput): PonderPacket {
  const now = Date.now()
  const packet = bindHarnessFrictionEvolutionCase(agentRoot, {
    id: generateTimestampId("pkt"),
    kind: input.kind,
    sop: packetSop(input.kind),
    status: "drafting",
    objective: capStructuredRecordString(input.objective),
    summary: capStructuredRecordString(input.summary),
    successCriteria: capStructuredRecordStringArray(input.successCriteria),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.relatedObligationId ? { relatedObligationId: input.relatedObligationId } : {}),
    ...(input.relatedReturnObligationId ? { relatedReturnObligationId: input.relatedReturnObligationId } : {}),
    ...(input.followsPacketId ? { followsPacketId: input.followsPacketId } : {}),
    payload: capStructuredRecordStringLeaves(input.payload),
    createdAt: now,
    updatedAt: now,
  })
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
    objective: capStructuredRecordString(input.objective),
    summary: capStructuredRecordString(input.summary),
    successCriteria: capStructuredRecordStringArray(input.successCriteria),
    payload: capStructuredRecordStringLeaves(input.payload),
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

const PONDER_PACKET_COMPLETION_PATH: Record<TaskStatus, readonly TaskStatus[]> = {
  drafting: ["processing", "validating", "done"],
  processing: ["validating", "done"],
  validating: ["done"],
  collaborating: ["validating", "done"],
  paused: ["processing", "validating", "done"],
  blocked: ["processing", "validating", "done"],
  done: [],
  cancelled: [],
}

export function completePonderPacket(agentRoot: string, packetId: string): PonderPacket {
  let packet = readPonderPacket(agentRoot, packetId)
  if (!packet) {
    throw new Error(`packet not found: ${packetId}`)
  }

  for (const status of PONDER_PACKET_COMPLETION_PATH[packet.status]) {
    packet = advancePonderPacket(agentRoot, packet.id, { status })
  }

  return packet
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
