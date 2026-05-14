import * as path from "path"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { generateTimestampId, readJsonDir, readJsonFileOrThrow, writeJsonFile } from "./json-store"

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
  const id = generateTimestampId("int")
  const intention: IntentionRecord = {
    id,
    content: capStructuredRecordString(input.content),
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

  writeJsonFile(intentionsDir(agentRoot), id, intention)

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
  const all = readJsonDir<IntentionRecord>(dir)
  const limit = options?.limit ?? 20
  const intentions = all.filter((i) => i.status === "open")

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
  return readJsonFileOrThrow<IntentionRecord>(intentionsDir(agentRoot), id, "Intention")
}

function writeIntentionFile(agentRoot: string, intention: IntentionRecord): void {
  writeJsonFile(intentionsDir(agentRoot), intention.id, intention)
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
