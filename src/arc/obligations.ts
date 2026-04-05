import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { generateTimestampId, readJsonDir, readJsonFile, writeJsonFile } from "./json-store"

export type ObligationStatus =
  | "pending"
  | "investigating"
  | "waiting_for_merge"
  | "updating_runtime"
  | "fulfilled"

export interface ObligationSurface {
  kind: "session" | "coding" | "merge" | "runtime"
  label: string
}

export interface WaitingOnRef {
  kind: "friend" | "agent" | "coding" | "merge" | "runtime" | "time" | "none"
  target: string
  detail: string
}

export interface ObligationMeaning {
  salience: "low" | "medium" | "high" | "critical"
  careReason?: string
  waitingOn?: WaitingOnRef | null
  stalenessClass: "fresh" | "warm" | "stale" | "cold" | "at-risk"
  lastMeaningfulChangeAt?: string
  resumeHint?: string
}

export interface Obligation {
  id: string
  origin: { friendId: string; channel: string; key: string }
  bridgeId?: string
  content: string
  status: ObligationStatus
  createdAt: string
  updatedAt?: string
  currentSurface?: ObligationSurface
  currentArtifact?: string
  nextAction?: string
  latestNote?: string
  fulfilledAt?: string
  meaning?: ObligationMeaning
}

function obligationsDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "obligations")
}



export function isOpenObligationStatus(status: ObligationStatus): boolean {
  return status !== "fulfilled"
}

export function isOpenObligation(obligation: Obligation): boolean {
  return isOpenObligationStatus(obligation.status)
}

export function createObligation(
  agentRoot: string,
  input: Omit<Obligation, "id" | "createdAt" | "status">,
): Obligation {
  const now = new Date().toISOString()
  const id = generateTimestampId()
  const obligation: Obligation = {
    id,
    origin: input.origin,
    ...(input.bridgeId ? { bridgeId: input.bridgeId } : {}),
    content: input.content,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }

  writeJsonFile(obligationsDir(agentRoot), id, obligation)

  emitNervesEvent({
    component: "engine",
    event: "engine.obligation_created",
    message: "obligation created",
    meta: {
      obligationId: id,
      friendId: input.origin.friendId,
      channel: input.origin.channel,
      key: input.origin.key,
    },
  })

  return obligation
}

export function readObligations(agentRoot: string): Obligation[] {
  const all = readJsonDir<Obligation>(obligationsDir(agentRoot))
  return all.filter((parsed) => typeof parsed.id === "string" && typeof parsed.content === "string")
}

export function readPendingObligations(agentRoot: string): Obligation[] {
  return readObligations(agentRoot).filter(isOpenObligation)
}

export function advanceObligation(
  agentRoot: string,
  obligationId: string,
  update: {
    status?: ObligationStatus
    currentSurface?: ObligationSurface
    currentArtifact?: string
    nextAction?: string
    latestNote?: string
  },
): void {
  const dir = obligationsDir(agentRoot)
  const obligation = readJsonFile<Obligation>(dir, obligationId)
  if (!obligation) return

  const previousStatus = obligation.status
  if (update.status) {
    obligation.status = update.status
    if (update.status === "fulfilled") {
      obligation.fulfilledAt = new Date().toISOString()
    }
  }
  if (update.currentSurface) {
    obligation.currentSurface = update.currentSurface
  }
  if (typeof update.currentArtifact === "string") {
    obligation.currentArtifact = update.currentArtifact
  }
  if (typeof update.nextAction === "string") {
    obligation.nextAction = update.nextAction
  }
  if (typeof update.latestNote === "string") {
    obligation.latestNote = update.latestNote
  }
  obligation.updatedAt = new Date().toISOString()
  writeJsonFile(dir, obligationId, obligation)

  emitNervesEvent({
    component: "engine",
    event: "engine.obligation_advanced",
    message: "obligation advanced",
    meta: {
      obligationId,
      previousStatus,
      status: obligation.status,
      friendId: obligation.origin.friendId,
      channel: obligation.origin.channel,
      key: obligation.origin.key,
      surfaceKind: obligation.currentSurface?.kind ?? null,
      surfaceLabel: obligation.currentSurface?.label ?? null,
    },
  })
}

export function fulfillObligation(agentRoot: string, obligationId: string): void {
  advanceObligation(agentRoot, obligationId, { status: "fulfilled" })

  const obligation = readJsonFile<Obligation>(obligationsDir(agentRoot), obligationId)
  if (!obligation) return

  emitNervesEvent({
    component: "engine",
    event: "engine.obligation_fulfilled",
    message: "obligation fulfilled",
    meta: {
      obligationId,
      friendId: obligation.origin.friendId,
      channel: obligation.origin.channel,
      key: obligation.origin.key,
    },
  })
}

export function findPendingObligationForOrigin(
  agentRoot: string,
  origin: { friendId: string; channel: string; key: string },
): Obligation | undefined {
  return readPendingObligations(agentRoot).find(
    (ob) =>
      ob.origin.friendId === origin.friendId
      && ob.origin.channel === origin.channel
      && ob.origin.key === origin.key,
  )
}

export function enrichObligation(
  agentRoot: string,
  id: string,
  meaning: ObligationMeaning,
): Obligation {
  const dir = obligationsDir(agentRoot)
  const existing = readJsonFile<Obligation>(dir, id)
  if (!existing) {
    throw new Error(`Obligation not found: ${id}`)
  }

  const obligation = existing
  obligation.meaning = meaning
  obligation.updatedAt = new Date().toISOString()
  writeJsonFile(dir, id, obligation)

  emitNervesEvent({
    component: "engine",
    event: "engine.obligation_enriched",
    message: "obligation enriched with meaning",
    meta: {
      obligationId: id,
      salience: meaning.salience,
      stalenessClass: meaning.stalenessClass,
    },
  })

  return obligation
}

// ── Return Obligations ──────────────────────────────────────────
// Delegated inner-work obligations (formerly mind/obligations.ts).
// Stored under arc/obligations/inner/ to keep them separate from
// the main obligation files.
//
// **When to use which:**
// - Obligation (above): "I owe someone a response or completion."
//   Created when a friend asks something that requires sustained work.
//   Rich lifecycle: pending → investigating → waiting_for_merge → fulfilled.
//
// - ReturnObligation (below): "I've been delegated work via inner dialog
//   and need to route the result back." Created when ponder delegates
//   inward. Lightweight lifecycle: queued → running → returned/deferred.
//
// Nerves events use component: "mind" (conceptual domain, not file location)
// to keep observability semantics stable across refactors.

export type ReturnObligationStatus = "queued" | "running" | "returned" | "deferred"
export type ReturnTarget = "bridge-session" | "direct-originator" | "freshest-session" | "deferred" | "surface"

export interface ReturnObligation {
  id: string
  origin: {
    friendId: string
    channel: string
    key: string
    bridgeId?: string
  }
  status: ReturnObligationStatus
  delegatedContent: string
  createdAt: number
  startedAt?: number
  returnedAt?: number
  returnTarget?: ReturnTarget
}

export function generateObligationId(timestamp: number): string {
  return `${timestamp}-${Math.random().toString(36).slice(2, 10)}`
}

export function getReturnObligationsDir(agentName: string): string {
  return path.join(getAgentRoot(agentName), "arc", "obligations", "inner")
}

export function createReturnObligation(agentName: string, obligation: ReturnObligation): string {
  const dir = getReturnObligationsDir(agentName)
  writeJsonFile(dir, obligation.id, obligation)
  const filePath = path.join(dir, `${obligation.id}.json`)

  emitNervesEvent({
    event: "mind.obligation_created",
    component: "mind",
    message: "return obligation created",
    meta: {
      obligationId: obligation.id,
      origin: `${obligation.origin.friendId}/${obligation.origin.channel}/${obligation.origin.key}`,
      status: obligation.status,
    },
  })

  return filePath
}

export function readReturnObligation(agentName: string, obligationId: string): ReturnObligation | null {
  return readJsonFile<ReturnObligation>(getReturnObligationsDir(agentName), obligationId)
}

export function advanceReturnObligation(
  agentName: string,
  obligationId: string,
  update: {
    status: ReturnObligationStatus
    startedAt?: number
    returnedAt?: number
    returnTarget?: ReturnTarget
  },
): ReturnObligation | null {
  const existing = readReturnObligation(agentName, obligationId)
  if (!existing) return null

  const updated: ReturnObligation = {
    ...existing,
    status: update.status,
    ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
    ...(update.returnedAt !== undefined ? { returnedAt: update.returnedAt } : {}),
    ...(update.returnTarget !== undefined ? { returnTarget: update.returnTarget } : {}),
  }

  writeJsonFile(getReturnObligationsDir(agentName), obligationId, updated)

  emitNervesEvent({
    event: "mind.obligation_advanced",
    component: "mind",
    message: `obligation advanced to ${update.status}`,
    meta: {
      obligationId,
      status: update.status,
      ...(update.returnTarget ? { returnTarget: update.returnTarget } : {}),
    },
  })

  return updated
}

export function listActiveReturnObligations(agentName: string): ReturnObligation[] {
  const all = readJsonDir<ReturnObligation>(getReturnObligationsDir(agentName))
  return all
    .filter((parsed) => parsed.status === "queued" || parsed.status === "running")
    .sort((a, b) => a.createdAt - b.createdAt)
}
