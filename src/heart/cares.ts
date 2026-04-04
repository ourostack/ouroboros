import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { trackSyncWrite } from "./sync"

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

function careFilePath(agentRoot: string, id: string): string {
  return path.join(caresDir(agentRoot), `${id}.json`)
}

function generateId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 10)
  return `care-${timestamp}-${random}`
}

export function createCare(
  agentRoot: string,
  input: Omit<CareRecord, "id" | "createdAt" | "updatedAt">,
): CareRecord {
  const now = new Date().toISOString()
  const id = generateId()
  const care: CareRecord = {
    id,
    label: input.label,
    why: input.why,
    kind: input.kind,
    status: input.status,
    salience: input.salience,
    steward: input.steward,
    relatedFriendIds: input.relatedFriendIds,
    relatedAgentIds: input.relatedAgentIds,
    relatedObligationIds: input.relatedObligationIds,
    relatedEpisodeIds: input.relatedEpisodeIds,
    currentRisk: input.currentRisk,
    nextCheckAt: input.nextCheckAt,
    createdAt: now,
    updatedAt: now,
  }

  const dir = caresDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = careFilePath(agentRoot, id)
  fs.writeFileSync(filePath, JSON.stringify(care, null, 2), "utf-8")
  trackSyncWrite(filePath)

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
  if (!fs.existsSync(dir)) {
    emitNervesEvent({
      component: "heart",
      event: "heart.cares_read",
      message: "read cares: directory missing, returning empty",
      meta: { count: 0 },
    })
    return []
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const cares: CareRecord[] = []

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8")
      const care = JSON.parse(content) as CareRecord
      cares.push(care)
    } catch {
      // Skip malformed JSON files gracefully
    }
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.cares_read",
    message: `read ${cares.length} cares`,
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
  const filePath = careFilePath(agentRoot, id)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Care not found: ${id}`)
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
}

function writeCareFile(agentRoot: string, care: CareRecord): void {
  const filePath = careFilePath(agentRoot, care.id)
  fs.writeFileSync(filePath, JSON.stringify(care, null, 2), "utf-8")
  trackSyncWrite(filePath)
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
