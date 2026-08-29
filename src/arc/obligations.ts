import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { capStructuredRecordString } from "../heart/session-events"
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

export interface ObligationProvenance {
  kind: "human_request" | "agent_promise" | "machine_evidence"
  source: string
  ref: string
}

export interface Obligation {
  id: string
  origin: { friendId: string; channel: string; key: string }
  sourceProvenance?: ObligationProvenance
  owedTo?: { friendId: string; channel: string; key: string }
  requestId?: string
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

export function readObligation(agentRoot: string, obligationId: string): Obligation | null {
  return readJsonFile<Obligation>(obligationsDir(agentRoot), obligationId)
}

export function isOpenObligationStatus(status: ObligationStatus): boolean {
  return status !== "fulfilled"
}

export function isOpenObligation(obligation: Obligation): boolean {
  return isOpenObligationStatus(obligation.status)
}

function isReadableObligation(value: unknown): value is Obligation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const obligation = value as Partial<Obligation>
  return typeof obligation.id === "string"
    && typeof obligation.content === "string"
}

function isVerifiedObligationStatus(value: unknown): value is ObligationStatus {
  return value === "pending"
    || value === "investigating"
    || value === "waiting_for_merge"
    || value === "updating_runtime"
    || value === "fulfilled"
}

function isVerifiedObligation(value: unknown): value is Obligation {
  if (!isReadableObligation(value)) return false
  const obligation = value as Partial<Obligation>
  return isVerifiedObligationStatus(obligation.status)
    && typeof obligation.createdAt === "string"
    && !!obligation.origin
    && typeof obligation.origin.friendId === "string"
    && typeof obligation.origin.channel === "string"
    && typeof obligation.origin.key === "string"
}

export function createObligation(
  agentRoot: string,
  input: Omit<Obligation, "id" | "createdAt" | "status">,
): Obligation {
  if (input.sourceProvenance?.kind === "machine_evidence" && !input.owedTo) {
    throw new Error("Machine evidence cannot create an obligation without a person owed a return")
  }
  const now = new Date().toISOString()
  const id = generateTimestampId()
  const obligation: Obligation = {
    id,
    origin: input.origin,
    sourceProvenance: input.sourceProvenance ?? {
      kind: "human_request",
      source: input.origin.channel,
      ref: input.origin.key,
    },
    owedTo: input.owedTo ?? input.origin,
    ...(input.requestId ? { requestId: capStructuredRecordString(input.requestId) } : {}),
    ...(input.bridgeId ? { bridgeId: input.bridgeId } : {}),
    content: capStructuredRecordString(input.content),
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
  return all.filter(isReadableObligation)
}

export function readPendingObligations(agentRoot: string): Obligation[] {
  return readObligations(agentRoot).filter(isOpenObligation)
}

export function readVerifiedObligations(agentRoot: string): Obligation[] {
  const all = readJsonDir<Obligation>(obligationsDir(agentRoot))
  return all.filter(isVerifiedObligation)
}

export function readVerifiedPendingObligations(agentRoot: string): Obligation[] {
  return readVerifiedObligations(agentRoot).filter(isOpenObligation)
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
    obligation.currentArtifact = capStructuredRecordString(update.currentArtifact)
  }
  if (typeof update.nextAction === "string") {
    obligation.nextAction = capStructuredRecordString(update.nextAction)
  }
  if (typeof update.latestNote === "string") {
    obligation.latestNote = capStructuredRecordString(update.latestNote)
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
  obligation.meaning = {
    ...meaning,
    ...(typeof meaning.careReason === "string" ? { careReason: capStructuredRecordString(meaning.careReason) } : {}),
    ...(typeof meaning.resumeHint === "string" ? { resumeHint: capStructuredRecordString(meaning.resumeHint) } : {}),
    ...(meaning.waitingOn
      ? { waitingOn: { ...meaning.waitingOn, detail: capStructuredRecordString(meaning.waitingOn.detail) } }
      : {}),
  }
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
// - ReturnObligation (below): "I've been delegated work via private runtime
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
  packetId?: string
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

export function getReturnObligationsDirForRoot(agentRoot: string): string {
  return path.join(agentRoot, "arc", "obligations", "inner")
}

export function createReturnObligation(agentName: string, obligation: ReturnObligation): string {
  const dir = getReturnObligationsDir(agentName)
  const cappedObligation: ReturnObligation = {
    ...obligation,
    delegatedContent: capStructuredRecordString(obligation.delegatedContent),
  }
  writeJsonFile(dir, obligation.id, cappedObligation)
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

export function readReturnObligationForRoot(agentRoot: string, obligationId: string): ReturnObligation | null {
  return readJsonFile<ReturnObligation>(getReturnObligationsDirForRoot(agentRoot), obligationId)
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

  // Private-runtime return obligations that have been sitting in queued/running state
// longer than this are auto-pruned from the "held work items" injection.
// Anything older is overwhelmingly noise: the agent has had many turns to
// resolve them and has not, and reinjecting them every turn just burns
// attention without producing progress. The file stays on disk and can
// still be inspected or surfaced explicitly; it just no longer gets
// re-piped into the active prompt.
const RETURN_OBLIGATION_INJECTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

// Strict allow-list of statuses that should appear in the "held work items"
// section. Anything else (including legacy/migrated `"fulfilled"` values left
// over from before the ObligationStatus → ReturnObligationStatus split, plus
// any future invalid value that slips past the `as any` casts at the
// surface-tool boundary) is treated as terminal — i.e., we do not re-inject
// it. This is a read-time defense; the underlying file is left as-is.
const ACTIVE_RETURN_OBLIGATION_STATUSES: ReadonlySet<ReturnObligationStatus> = new Set(["queued", "running"])

export function isActiveReturnObligationStatus(status: string): status is "queued" | "running" {
  return ACTIVE_RETURN_OBLIGATION_STATUSES.has(status as ReturnObligationStatus)
}

function isSelfInnerReturnObligation(obligation: ReturnObligation): boolean {
  return obligation.origin?.friendId === "self" && obligation.origin.channel === "inner"
}

function isReturnObligationRecord(value: unknown): value is ReturnObligation {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ReturnObligation>
  return typeof candidate.id === "string"
    && typeof candidate.status === "string"
    && typeof candidate.delegatedContent === "string"
    && typeof candidate.createdAt === "number"
    && !!candidate.origin
    && typeof candidate.origin.friendId === "string"
    && typeof candidate.origin.channel === "string"
    && typeof candidate.origin.key === "string"
}

export function listReturnObligationsForRoot(agentRoot: string): ReturnObligation[] {
  return readJsonDir<ReturnObligation>(getReturnObligationsDirForRoot(agentRoot))
    .filter(isReturnObligationRecord)
}

export function isActiveReturnObligationRecord(
  value: unknown,
  options: { now?: () => number } = {},
): value is ReturnObligation {
  if (!isReturnObligationRecord(value)) return false
  const nowMs = (options.now ?? Date.now)()
  return isActiveReturnObligationStatus(value.status)
    && !isSelfInnerReturnObligation(value)
    && nowMs - value.createdAt <= RETURN_OBLIGATION_INJECTION_MAX_AGE_MS
}

export function listActiveReturnObligations(agentName: string, options: { now?: () => number } = {}): ReturnObligation[] {
  return listActiveReturnObligationsForRoot(getAgentRoot(agentName), options)
}

export function listActiveReturnObligationsForRoot(
  agentRoot: string,
  options: { now?: () => number } = {},
): ReturnObligation[] {
  const nowMs = (options.now ?? Date.now)()
  return listReturnObligationsForRoot(agentRoot)
    .filter((parsed) => isActiveReturnObligationRecord(parsed, { now: () => nowMs }))
    .sort((a, b) => a.createdAt - b.createdAt)
}
