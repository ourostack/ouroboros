import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface IntentionRecord {
  id: string
  content: string
  status: "open" | "done" | "dismissed"
  createdAt: string
  updatedAt: string
  relatedFriendId?: string
  relatedObligationId?: string
  relatedCareId?: string
  nudgeAfter?: string
  salience?: "low" | "medium" | "high"
  source: "thought" | "tool" | "coding" | "reflection"
}

function intentionsDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "intentions")
}

function intentionFilePath(agentRoot: string, id: string): string {
  return path.join(intentionsDir(agentRoot), `${id}.json`)
}

function generateId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 10)
  return `int-${timestamp}-${random}`
}

const SALIENCE_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

function salienceRank(salience?: string): number {
  if (!salience) return 0
  return SALIENCE_ORDER[salience] ?? 0
}

export function captureIntention(
  agentRoot: string,
  input: {
    content: string
    salience?: "low" | "medium" | "high"
    source: IntentionRecord["source"]
    relatedFriendId?: string
    relatedObligationId?: string
    relatedCareId?: string
    nudgeAfter?: string
  },
): IntentionRecord {
  const now = new Date().toISOString()
  const id = generateId()
  const intention: IntentionRecord = {
    id,
    content: input.content,
    status: "open",
    createdAt: now,
    updatedAt: now,
    ...(input.salience ? { salience: input.salience } : {}),
    source: input.source,
    ...(input.relatedFriendId ? { relatedFriendId: input.relatedFriendId } : {}),
    ...(input.relatedObligationId ? { relatedObligationId: input.relatedObligationId } : {}),
    ...(input.relatedCareId ? { relatedCareId: input.relatedCareId } : {}),
    ...(input.nudgeAfter ? { nudgeAfter: input.nudgeAfter } : {}),
  }

  const dir = intentionsDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(intentionFilePath(agentRoot, id), JSON.stringify(intention, null, 2), "utf-8")

  emitNervesEvent({
    component: "heart",
    event: "heart.intention_captured",
    message: `intention captured: ${input.content.slice(0, 60)}`,
    meta: { intentionId: id, source: input.source, salience: input.salience },
  })

  return intention
}

export function readOpenIntentions(
  agentRoot: string,
  options?: { limit?: number },
): IntentionRecord[] {
  const dir = intentionsDir(agentRoot)
  if (!fs.existsSync(dir)) {
    emitNervesEvent({
      component: "heart",
      event: "heart.intentions_read",
      message: "read intentions: directory missing, returning empty",
      meta: { count: 0 },
    })
    return []
  }

  const limit = options?.limit ?? 20
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const intentions: IntentionRecord[] = []

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8")
      const intention = JSON.parse(content) as IntentionRecord
      if (intention.status === "open") {
        intentions.push(intention)
      }
    } catch {
      // Skip malformed JSON files
    }
  }

  // Sort by salience descending, then createdAt descending
  intentions.sort((a, b) => {
    const salienceDiff = salienceRank(b.salience) - salienceRank(a.salience)
    if (salienceDiff !== 0) return salienceDiff
    return b.createdAt.localeCompare(a.createdAt)
  })

  const result = intentions.slice(0, limit)

  emitNervesEvent({
    component: "heart",
    event: "heart.intentions_read",
    message: `read ${result.length} open intentions`,
    meta: { count: result.length, total: intentions.length, limit },
  })

  return result
}

function readIntentionFile(agentRoot: string, id: string): IntentionRecord {
  const filePath = intentionFilePath(agentRoot, id)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Intention not found: ${id}`)
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as IntentionRecord
}

function writeIntentionFile(agentRoot: string, intention: IntentionRecord): void {
  fs.writeFileSync(
    intentionFilePath(agentRoot, intention.id),
    JSON.stringify(intention, null, 2),
    "utf-8",
  )
}

export function resolveIntention(agentRoot: string, id: string): IntentionRecord {
  const intention = readIntentionFile(agentRoot, id)
  intention.status = "done"
  intention.updatedAt = new Date().toISOString()
  writeIntentionFile(agentRoot, intention)

  emitNervesEvent({
    component: "heart",
    event: "heart.intention_resolved",
    message: `intention resolved: ${intention.content.slice(0, 60)}`,
    meta: { intentionId: id },
  })

  return intention
}

export function dismissIntention(agentRoot: string, id: string): IntentionRecord {
  const intention = readIntentionFile(agentRoot, id)
  intention.status = "dismissed"
  intention.updatedAt = new Date().toISOString()
  writeIntentionFile(agentRoot, intention)

  emitNervesEvent({
    component: "heart",
    event: "heart.intention_dismissed",
    message: `intention dismissed: ${intention.content.slice(0, 60)}`,
    meta: { intentionId: id },
  })

  return intention
}
