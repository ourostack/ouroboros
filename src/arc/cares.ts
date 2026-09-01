import * as path from "path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { withImmediateSessionTurnLease } from "../mind/session-transaction"
import { generateTimestampId, readJsonDir, readJsonFileOrThrow } from "./json-store"

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

export const CARE_INCIDENT_RECOVERY_REVIEW_RISK = "The verified incident recovered, but this Care still has unresolved context that needs review."

export function isManagedDockerCareIncidentBinding(binding: CareIncidentBinding): boolean {
  return binding.source === "sanctuary-health::Docker_critical_image_disk_utilization"
    && /^docker-image-disk-(?:100|[1-9]?[0-9])pct-[0-9]{8}T[0-9]{4}Z$/u.test(binding.incidentKey)
    && /^[a-f0-9]{64}$/u.test(binding.classifiedRevision)
    && binding.correlationKey === undefined
    && binding.resolvedAt === undefined
}

export interface StaleCareEvidence {
  id: string
  kind: "system"
  status: "active" | "watching"
  salience: CareRecord["salience"]
  steward: CareStewardship
  evidenceStatus: "stale"
  recheckRequired: true
  staleAt: string
  lastAssessedAt: string
}

export function projectCareEvidence(care: CareRecord, now = Date.now()): CareRecord | StaleCareEvidence {
  if (care.kind !== "system" || (care.status !== "active" && care.status !== "watching") || care.nextCheckAt === null) return care
  const staleAt = Date.parse(care.nextCheckAt)
  if (Number.isFinite(staleAt) && staleAt > now) return care
  return {
    id: care.id,
    kind: care.kind,
    status: care.status,
    salience: care.salience,
    steward: care.steward,
    evidenceStatus: "stale",
    recheckRequired: true,
    staleAt: care.nextCheckAt,
    lastAssessedAt: care.updatedAt,
  }
}

function caresDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "cares")
}

function withCareMutationLock<T>(agentRoot: string, operation: () => T): T {
  const dir = caresDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return withImmediateSessionTurnLease(path.join(dir, ".mutation"), () => operation())
}

function writeCareFile(agentRoot: string, care: CareRecord): void {
  const dir = caresDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const destination = path.join(dir, `${care.id}.json`)
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(care, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  const handle = fs.openSync(temporary, "r")
  try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  fs.renameSync(temporary, destination)
  const directory = fs.openSync(dir, "r")
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

export function createCare(
  agentRoot: string,
  input: Omit<CareRecord, "id" | "createdAt" | "updatedAt">,
): CareRecord {
  return withCareMutationLock(agentRoot, () => createCareUnlocked(agentRoot, input))
}

function createCareUnlocked(
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

  writeCareFile(agentRoot, care)

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

export function updateCare(
  agentRoot: string,
  id: string,
  updates: Partial<CareRecord>,
): CareRecord {
  return withCareMutationLock(agentRoot, () => {
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
  })
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
  options: { expectedUpdatedAt: string },
): CareRecord {
  return withCareMutationLock(agentRoot, () => {
    const canonical = canonicalIncidentBinding(binding)
    const existingCare = readJsonDir<CareRecord>(caresDir(agentRoot)).find((candidate) =>
      candidate.incidentBindings?.some((item) => item.source === canonical.source && item.incidentKey === canonical.incidentKey),
    )
    const care = existingCare ?? readCareFile(agentRoot, id)
    const bindings = [...(care.incidentBindings ?? [])]
    const index = bindings.findIndex((candidate) => candidate.source === canonical.source && candidate.incidentKey === canonical.incidentKey)
    if (index >= 0 && JSON.stringify(bindings[index]) === JSON.stringify(canonical)) return care
    if (!options.expectedUpdatedAt || care.updatedAt !== options.expectedUpdatedAt) throw new Error("Care incident binding CAS mismatch")
    if (index >= 0) bindings[index] = canonical
    else bindings.push(canonical)
    const updated = { ...care, incidentBindings: bindings, updatedAt: nextUpdatedAt(care.updatedAt) }
    writeCareFile(agentRoot, updated)
    emitNervesEvent({
      component: "heart",
      event: "heart.care_incident_bound",
      message: "care incident binding recorded",
      meta: { careId: care.id, source: canonical.source, incidentKey: canonical.incidentKey, bindingCount: bindings.length },
    })
    return updated
  })
}

export function upsertCareForIncident(
  agentRoot: string,
  input: Omit<CareRecord, "id" | "createdAt" | "updatedAt" | "incidentBindings"> & { id?: string; incident: CareIncidentBinding; expectedUpdatedAt?: string },
): CareRecord {
  return withCareMutationLock(agentRoot, () => {
    const incident = canonicalIncidentBinding(input.incident)
    const existing = readJsonDir<CareRecord>(caresDir(agentRoot)).find((care) =>
      (!input.id || care.id === input.id) && care.incidentBindings?.some((binding) => binding.source === incident.source && binding.incidentKey === incident.incidentKey),
    )
    if (existing) {
      const index = existing.incidentBindings!.findIndex((binding) => binding.source === incident.source && binding.incidentKey === incident.incidentKey)
      const incidentStateUnchanged = JSON.stringify(existing.incidentBindings![index]) === JSON.stringify(incident)
        && existing.currentRisk === (input.currentRisk === null ? null : capStructuredRecordString(input.currentRisk))
        && existing.nextCheckAt === input.nextCheckAt
      const displayUnchanged = !input.id || (
        existing.label === capStructuredRecordString(input.label)
        && existing.why === capStructuredRecordString(input.why)
        && existing.kind === input.kind
        && existing.status === input.status
        && existing.salience === input.salience
        && existing.steward === input.steward
      )
      const unchanged = incidentStateUnchanged && displayUnchanged
      if (unchanged) return existing
      if (!input.expectedUpdatedAt || input.expectedUpdatedAt !== existing.updatedAt) throw new Error("Care incident upsert CAS mismatch")
      const incidentBindings = [...existing.incidentBindings!]
      incidentBindings[index] = incident
      const updated = {
        ...existing,
        label: capStructuredRecordString(input.label),
        why: capStructuredRecordString(input.why),
        kind: input.kind,
        status: input.status,
        salience: input.salience,
        steward: input.steward,
        currentRisk: input.currentRisk === null ? null : capStructuredRecordString(input.currentRisk),
        nextCheckAt: input.nextCheckAt,
        incidentBindings,
        updatedAt: nextUpdatedAt(existing.updatedAt),
      }
      writeCareFile(agentRoot, updated)
      return updated
    }
    if (input.id) throw new Error("Care incident upsert target not found")
    const { id: _id, incident: _incident, expectedUpdatedAt: _expectedUpdatedAt, ...careInput } = input
    return createCareUnlocked(agentRoot, { ...careInput, incidentBindings: [incident] })
  })
}

export function resolveCareIncident(
  agentRoot: string,
  id: string,
  input: {
    source: string
    incidentKey: string
    expectedUpdatedAt: string
    display?: Pick<CareRecord, "label" | "why" | "currentRisk" | "nextCheckAt">
  },
): CareRecord {
  return withCareMutationLock(agentRoot, () => {
    const care = readCareFile(agentRoot, id)
    if (!input.expectedUpdatedAt || care.updatedAt !== input.expectedUpdatedAt) throw new Error("Care incident resolution CAS mismatch")
    const bindings = [...(care.incidentBindings ?? [])]
    const index = bindings.findIndex((binding) => binding.source === input.source && binding.incidentKey === input.incidentKey)
    if (index < 0) throw new Error("Care incident binding not found")
    const display = input.display
    const requestedDisplay = display ? {
      label: capStructuredRecordString(display.label),
      why: capStructuredRecordString(display.why),
      currentRisk: display.currentRisk === null ? null : capStructuredRecordString(display.currentRisk),
      nextCheckAt: display.nextCheckAt,
    } : undefined
    const displayUnchanged = !requestedDisplay || JSON.stringify({
      label: care.label,
      why: care.why,
      currentRisk: care.currentRisk,
      nextCheckAt: care.nextCheckAt,
    }) === JSON.stringify(requestedDisplay)
    if (bindings[index].resolvedAt && displayUnchanged) return care
    const now = nextUpdatedAt(care.updatedAt)
    if (!bindings[index].resolvedAt) bindings[index] = { ...bindings[index], resolvedAt: now }
    const noUnresolvedBindings = bindings.every((binding) => binding.resolvedAt)
    const unresolvedBindingsBeforeResolution = care.incidentBindings!.filter((binding) => !binding.resolvedAt)
    const soleBindingOwnsRisk = care.kind === "system" && unresolvedBindingsBeforeResolution.length === 1 && isManagedDockerCareIncidentBinding(unresolvedBindingsBeforeResolution[0]!)
    const unresolvedContextRemains = !noUnresolvedBindings || (care.currentRisk !== null && !soleBindingOwnsRisk)
    const canonicalDisplay = requestedDisplay && requestedDisplay.currentRisk === null && unresolvedContextRemains
      ? { ...requestedDisplay, currentRisk: CARE_INCIDENT_RECOVERY_REVIEW_RISK, nextCheckAt: requestedDisplay.nextCheckAt ?? new Date(Date.parse(now) + 15 * 60_000).toISOString() }
      : requestedDisplay
    const resultingRisk = canonicalDisplay ? canonicalDisplay.currentRisk : care.currentRisk
    const shouldResolveCare = noUnresolvedBindings && (care.currentRisk === null || soleBindingOwnsRisk) && resultingRisk === null
    const updated: CareRecord = {
      ...care,
      ...canonicalDisplay,
      incidentBindings: bindings,
      ...(shouldResolveCare ? { status: "resolved", resolvedAt: care.resolvedAt ?? now } : {}),
      updatedAt: now,
    }
    writeCareFile(agentRoot, updated)
    emitNervesEvent({
      component: "heart",
      event: "heart.care_incident_resolved",
      message: "care incident binding resolved",
      meta: { careId: id, source: input.source, incidentKey: input.incidentKey, unresolvedCount: bindings.filter((binding) => !binding.resolvedAt).length },
    })
    return updated
  })
}

export function resolveCare(agentRoot: string, id: string): CareRecord {
  return withCareMutationLock(agentRoot, () => {
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
  })
}
