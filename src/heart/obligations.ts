import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

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
  return path.join(agentRoot, "state", "obligations")
}

function obligationFilePath(agentRoot: string, id: string): string {
  return path.join(obligationsDir(agentRoot), `${id}.json`)
}

function generateId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 10)
  return `${timestamp}-${random}`
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
  const id = generateId()
  const obligation: Obligation = {
    id,
    origin: input.origin,
    ...(input.bridgeId ? { bridgeId: input.bridgeId } : {}),
    content: input.content,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }

  const dir = obligationsDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(obligationFilePath(agentRoot, id), JSON.stringify(obligation, null, 2), "utf-8")

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
  const dir = obligationsDir(agentRoot)
  if (!fs.existsSync(dir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    /* v8 ignore next -- defensive: readdirSync race after existsSync @preserve */
    return []
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort()
  const obligations: Obligation[] = []

  for (const file of jsonFiles) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8")
      const parsed = JSON.parse(raw) as Obligation
      if (typeof parsed.id === "string" && typeof parsed.content === "string") {
        obligations.push(parsed)
      }
    } catch {
      // skip malformed files
    }
  }

  return obligations
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
  const filePath = obligationFilePath(agentRoot, obligationId)
  let obligation: Obligation
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    obligation = JSON.parse(raw) as Obligation
  } catch {
    return
  }

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
  fs.writeFileSync(filePath, JSON.stringify(obligation, null, 2), "utf-8")

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

  const filePath = obligationFilePath(agentRoot, obligationId)
  let obligation: Obligation
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    obligation = JSON.parse(raw) as Obligation
  } catch {
    return
  }

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
  const filePath = obligationFilePath(agentRoot, id)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Obligation not found: ${id}`)
  }

  const raw = fs.readFileSync(filePath, "utf-8")
  const obligation = JSON.parse(raw) as Obligation

  obligation.meaning = meaning
  obligation.updatedAt = new Date().toISOString()
  fs.writeFileSync(filePath, JSON.stringify(obligation, null, 2), "utf-8")

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
