import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

// ── Types ────────────────────────────────────────────────────────

export type ObligationStatus = "queued" | "running" | "returned" | "deferred"
export type ReturnTarget = "bridge-session" | "direct-originator" | "freshest-session" | "deferred" | "surface"

export interface ReturnObligation {
  id: string
  origin: {
    friendId: string
    channel: string
    key: string
    bridgeId?: string
  }
  status: ObligationStatus
  delegatedContent: string
  createdAt: number
  startedAt?: number
  returnedAt?: number
  returnTarget?: ReturnTarget
}

// ── Paths ────────────────────────────────────────────────────────

export function getObligationsDir(agentName: string): string {
  return path.join(getAgentRoot(agentName), "arc", "obligations", "inner")
}

// ── ID generation ────────────────────────────────────────────────

export function generateObligationId(timestamp: number): string {
  return `${timestamp}-${Math.random().toString(36).slice(2, 10)}`
}

// ── Store operations ─────────────────────────────────────────────

export function createObligation(agentName: string, obligation: ReturnObligation): string {
  const dir = getObligationsDir(agentName)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${obligation.id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(obligation, null, 2), "utf8")

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

export function readObligation(agentName: string, obligationId: string): ReturnObligation | null {
  const dir = getObligationsDir(agentName)
  try {
    const raw = fs.readFileSync(path.join(dir, `${obligationId}.json`), "utf-8")
    return JSON.parse(raw) as ReturnObligation
  } catch {
    return null
  }
}

export function advanceObligation(
  agentName: string,
  obligationId: string,
  update: {
    status: ObligationStatus
    startedAt?: number
    returnedAt?: number
    returnTarget?: ReturnTarget
  },
): ReturnObligation | null {
  const existing = readObligation(agentName, obligationId)
  if (!existing) return null

  const updated: ReturnObligation = {
    ...existing,
    status: update.status,
    ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
    ...(update.returnedAt !== undefined ? { returnedAt: update.returnedAt } : {}),
    ...(update.returnTarget !== undefined ? { returnTarget: update.returnTarget } : {}),
  }

  const dir = getObligationsDir(agentName)
  fs.writeFileSync(path.join(dir, `${obligationId}.json`), JSON.stringify(updated, null, 2), "utf8")

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

export function listActiveObligations(agentName: string): ReturnObligation[] {
  const dir = getObligationsDir(agentName)
  if (!fs.existsSync(dir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const obligations: ReturnObligation[] = []
  for (const file of entries) {
    if (!file.endsWith(".json")) continue
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8")
      const parsed = JSON.parse(raw) as ReturnObligation
      if (parsed.status === "queued" || parsed.status === "running") {
        obligations.push(parsed)
      }
    } catch {
      // skip unparseable
    }
  }

  return obligations.sort((a, b) => a.createdAt - b.createdAt)
}
