import * as path from "path"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { generateTimestampId, readJsonDir, readJsonFileOrThrow, writeJsonFile } from "./json-store"

export type CareKind = "person" | "agent" | "project" | "mission" | "system"
export type CareStatus = "active" | "watching" | "resolved" | "dormant"
export type CareStewardship = "mine" | "shared" | "delegated"

export interface CareIncidentBinding {
  source: string
  incidentKey: string
  classifiedRevision: string
  correlationKey?: string
  resolvedAt?: string
}

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
  incidentBindings?: CareIncidentBinding[]
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
    ...(input.incidentBindings ? { incidentBindings: input.incidentBindings.map((binding) => ({ ...binding })) } : {}),
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

function nextUpdatedAt(previous: string): string {
  const now = Date.now()
  const previousMs = Date.parse(previous)
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString()
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
  const now = nextUpdatedAt(care.updatedAt)

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

function canonicalIncidentBinding(binding: CareIncidentBinding): CareIncidentBinding {
  const source = capStructuredRecordString(binding.source).trim()
  const incidentKey = capStructuredRecordString(binding.incidentKey).trim()
  const classifiedRevision = capStructuredRecordString(binding.classifiedRevision).trim()
  if (!source || !incidentKey || !classifiedRevision) throw new Error("Care incident binding is invalid")
  return {
    source,
    incidentKey,
    classifiedRevision,
    ...(binding.correlationKey ? { correlationKey: capStructuredRecordString(binding.correlationKey) } : {}),
    ...(binding.resolvedAt ? { resolvedAt: binding.resolvedAt } : {}),
  }
}

export function bindCareIncident(
  agentRoot: string,
  id: string,
  binding: CareIncidentBinding,
  options: { expectedUpdatedAt?: string } = {},
): CareRecord {
  const care = readCareFile(agentRoot, id)
  if (options.expectedUpdatedAt !== undefined && care.updatedAt !== options.expectedUpdatedAt) throw new Error("Care incident binding CAS mismatch")
  const canonical = canonicalIncidentBinding(binding)
  const bindings = [...(care.incidentBindings ?? [])]
  const index = bindings.findIndex((candidate) => candidate.source === canonical.source && candidate.incidentKey === canonical.incidentKey)
  if (index >= 0) bindings[index] = canonical
  else bindings.push(canonical)
  const updated = { ...care, incidentBindings: bindings, updatedAt: nextUpdatedAt(care.updatedAt) }
  writeCareFile(agentRoot, updated)
  emitNervesEvent({
    component: "heart",
    event: "heart.care_incident_bound",
    message: "care incident binding recorded",
    meta: { careId: id, source: canonical.source, incidentKey: canonical.incidentKey, bindingCount: bindings.length },
  })
  return updated
}

export function resolveCareIncident(
  agentRoot: string,
  id: string,
  input: { source: string; incidentKey: string; expectedUpdatedAt?: string },
): CareRecord {
  const care = readCareFile(agentRoot, id)
  if (input.expectedUpdatedAt !== undefined && care.updatedAt !== input.expectedUpdatedAt) throw new Error("Care incident resolution CAS mismatch")
  const bindings = [...(care.incidentBindings ?? [])]
  const index = bindings.findIndex((binding) => binding.source === input.source && binding.incidentKey === input.incidentKey)
  if (index < 0) throw new Error("Care incident binding not found")
  const now = nextUpdatedAt(care.updatedAt)
  bindings[index] = { ...bindings[index], resolvedAt: now }
  const updated = { ...care, incidentBindings: bindings, updatedAt: now }
  writeCareFile(agentRoot, updated)
  emitNervesEvent({
    component: "heart",
    event: "heart.care_incident_resolved",
    message: "care incident binding resolved",
    meta: { careId: id, source: input.source, incidentKey: input.incidentKey, unresolvedCount: bindings.filter((binding) => !binding.resolvedAt).length },
  })
  return updated
}

export function resolveCare(agentRoot: string, id: string): CareRecord {
  const care = readCareFile(agentRoot, id)
  const now = nextUpdatedAt(care.updatedAt)

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
