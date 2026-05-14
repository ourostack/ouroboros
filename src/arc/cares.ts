import * as path from "path"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { generateTimestampId, readJsonDir, readJsonFileOrThrow, writeJsonFile } from "./json-store"

export type CareKind = "person" | "agent" | "project" | "mission" | "system"
export type CareStatus = "active" | "watching" | "resolved" | "dormant"
export type CareStewardship = "mine" | "shared" | "delegated"

export interface CareRecord {
  id: string
  label: string
  why: string
  kind: CareKind
  status: CareStatus
  salience: "low" | "medium" | "high" | "critical"
  steward: CareStewardship
  relatedFriendIds: string[]
  relatedAgentIds: string[]
  relatedObligationIds: string[]
  relatedEpisodeIds: string[]
  currentRisk: string | null
  nextCheckAt: string | null
  createdAt: string
  updatedAt: string
  resolvedAt?: string
}

function caresDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "cares")
}

export function createCare(
  agentRoot: string,
  input: Omit<CareRecord, "id" | "createdAt" | "updatedAt">,
): CareRecord {
  const now = new Date().toISOString()
  const id = generateTimestampId("care")
  const care: CareRecord = {
    id,
    label: capStructuredRecordString(input.label),
    why: capStructuredRecordString(input.why),
    kind: input.kind,
    status: input.status,
    salience: input.salience,
    steward: input.steward,
    relatedFriendIds: input.relatedFriendIds,
    relatedAgentIds: input.relatedAgentIds,
    relatedObligationIds: input.relatedObligationIds,
    relatedEpisodeIds: input.relatedEpisodeIds,
    currentRisk: input.currentRisk === null ? null : capStructuredRecordString(input.currentRisk),
    nextCheckAt: input.nextCheckAt,
    createdAt: now,
    updatedAt: now,
  }

  writeJsonFile(caresDir(agentRoot), id, care)

  emitNervesEvent({
    component: "heart",
    event: "heart.care_created",
    message: `care created: ${input.label}`,
    meta: { careId: id, status: input.status, salience: input.salience },
  })

  return care
}

export function readCares(agentRoot: string): CareRecord[] {
  const dir = caresDir(agentRoot)
  const cares = readJsonDir<CareRecord>(dir)

  emitNervesEvent({
    component: "heart",
    event: "heart.cares_read",
    message: cares.length === 0 ? "read cares: directory missing, returning empty" : `read ${cares.length} cares`,
    meta: { count: cares.length },
  })

  return cares
}

export function readActiveCares(agentRoot: string): CareRecord[] {
  const all = readCares(agentRoot)
  const active = all.filter((c) => c.status === "active" || c.status === "watching")

  emitNervesEvent({
    component: "heart",
    event: "heart.active_cares_read",
    message: `read ${active.length} active cares`,
    meta: { count: active.length, total: all.length },
  })

  return active
}

function readCareFile(agentRoot: string, id: string): CareRecord {
  return readJsonFileOrThrow<CareRecord>(caresDir(agentRoot), id, "Care")
}

function writeCareFile(agentRoot: string, care: CareRecord): void {
  writeJsonFile(caresDir(agentRoot), care.id, care)
}

export function updateCare(
  agentRoot: string,
  id: string,
  updates: Partial<CareRecord>,
): CareRecord {
  const care = readCareFile(agentRoot, id)
  const now = new Date().toISOString()

  const updated: CareRecord = {
    ...care,
    ...updates,
    ...(typeof updates.label === "string" ? { label: capStructuredRecordString(updates.label) } : {}),
    ...(typeof updates.why === "string" ? { why: capStructuredRecordString(updates.why) } : {}),
    ...(typeof updates.currentRisk === "string" ? { currentRisk: capStructuredRecordString(updates.currentRisk) } : {}),
    id: care.id, // protect ID from overwrite
    createdAt: care.createdAt, // protect createdAt
    updatedAt: now,
  }

  writeCareFile(agentRoot, updated)

  emitNervesEvent({
    component: "heart",
    event: "heart.care_updated",
    message: `care updated: ${updated.label}`,
    meta: { careId: id, updates: Object.keys(updates) },
  })

  return updated
}

export function resolveCare(agentRoot: string, id: string): CareRecord {
  const care = readCareFile(agentRoot, id)
  const now = new Date().toISOString()

  const resolved: CareRecord = {
    ...care,
    status: "resolved",
    resolvedAt: now,
    updatedAt: now,
  }

  writeCareFile(agentRoot, resolved)

  emitNervesEvent({
    component: "heart",
    event: "heart.care_resolved",
    message: `care resolved: ${resolved.label}`,
    meta: { careId: id },
  })

  return resolved
}
