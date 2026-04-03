import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface RelationshipOutcome {
  missionId: string
  result: "success" | "partial" | "failed"
  timestamp: string
  note?: string
}

export interface AgentRelationship {
  agentName: string
  displayName: string
  familiarity: number
  trust: "neutral" | "growing" | "established" | "strong"
  sharedMissions: string[]
  lastInteraction: string
  outcomes: RelationshipOutcome[]
  notes: string[]
}

function relationshipsDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "relationships")
}

function relationshipFilePath(agentRoot: string, agentName: string): string {
  return path.join(relationshipsDir(agentRoot), `${agentName.toLowerCase()}.json`)
}

function readRelationshipFile(agentRoot: string, agentName: string): AgentRelationship | null {
  const filePath = relationshipFilePath(agentRoot, agentName)
  if (!fs.existsSync(filePath)) {
    return null
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentRelationship
}

function writeRelationshipFile(agentRoot: string, rel: AgentRelationship): void {
  const dir = relationshipsDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${rel.agentName}.json`),
    JSON.stringify(rel, null, 2),
    "utf-8",
  )
}

export function recordInteraction(
  agentRoot: string,
  agentName: string,
  context: { displayName?: string; missionId?: string; note?: string },
): AgentRelationship {
  const normalizedName = agentName.toLowerCase()
  const now = new Date().toISOString()
  const existing = readRelationshipFile(agentRoot, normalizedName)

  if (existing) {
    existing.familiarity += 1
    existing.lastInteraction = now
    if (context.displayName) {
      existing.displayName = context.displayName
    }
    if (context.missionId && !existing.sharedMissions.includes(context.missionId)) {
      existing.sharedMissions.push(context.missionId)
    }
    if (context.note) {
      existing.notes.push(context.note)
    }

    writeRelationshipFile(agentRoot, existing)

    emitNervesEvent({
      component: "heart",
      event: "heart.relationship_updated",
      message: `relationship updated: ${normalizedName}`,
      meta: { agentName: normalizedName, familiarity: existing.familiarity },
    })

    return existing
  }

  const rel: AgentRelationship = {
    agentName: normalizedName,
    displayName: context.displayName ?? normalizedName,
    familiarity: 1,
    trust: "neutral",
    sharedMissions: context.missionId ? [context.missionId] : [],
    lastInteraction: now,
    outcomes: [],
    notes: context.note ? [context.note] : [],
  }

  writeRelationshipFile(agentRoot, rel)

  emitNervesEvent({
    component: "heart",
    event: "heart.relationship_created",
    message: `relationship created: ${normalizedName}`,
    meta: { agentName: normalizedName },
  })

  return rel
}

export function readRelationships(agentRoot: string): AgentRelationship[] {
  const dir = relationshipsDir(agentRoot)
  if (!fs.existsSync(dir)) {
    emitNervesEvent({
      component: "heart",
      event: "heart.relationships_read",
      message: "read relationships: directory missing, returning empty",
      meta: { count: 0 },
    })
    return []
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const relationships: AgentRelationship[] = []

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8")
      const rel = JSON.parse(content) as AgentRelationship
      relationships.push(rel)
    } catch {
      // Skip malformed JSON files
    }
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.relationships_read",
    message: `read ${relationships.length} relationships`,
    meta: { count: relationships.length },
  })

  return relationships
}

export function readRelationship(
  agentRoot: string,
  agentName: string,
): AgentRelationship | null {
  const rel = readRelationshipFile(agentRoot, agentName)

  emitNervesEvent({
    component: "heart",
    event: "heart.relationship_read",
    message: rel ? `read relationship: ${agentName.toLowerCase()}` : `relationship not found: ${agentName.toLowerCase()}`,
    meta: { agentName: agentName.toLowerCase(), found: !!rel },
  })

  return rel
}

export function recordOutcome(
  agentRoot: string,
  agentName: string,
  outcome: RelationshipOutcome,
): AgentRelationship {
  const normalizedName = agentName.toLowerCase()
  const existing = readRelationshipFile(agentRoot, normalizedName)

  if (!existing) {
    throw new Error(`Agent relationship not found: ${normalizedName}`)
  }

  existing.outcomes.push(outcome)
  writeRelationshipFile(agentRoot, existing)

  emitNervesEvent({
    component: "heart",
    event: "heart.outcome_recorded",
    message: `outcome recorded for ${normalizedName}: ${outcome.result}`,
    meta: { agentName: normalizedName, missionId: outcome.missionId, result: outcome.result },
  })

  return existing
}
