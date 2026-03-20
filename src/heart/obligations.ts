import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface Obligation {
  id: string
  origin: { friendId: string; channel: string; key: string }
  bridgeId?: string
  content: string
  status: "pending" | "fulfilled"
  createdAt: string
  fulfilledAt?: string
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

export function createObligation(
  agentRoot: string,
  input: Omit<Obligation, "id" | "createdAt" | "status">,
): Obligation {
  const id = generateId()
  const obligation: Obligation = {
    id,
    origin: input.origin,
    ...(input.bridgeId ? { bridgeId: input.bridgeId } : {}),
    content: input.content,
    status: "pending",
    createdAt: new Date().toISOString(),
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
  return readObligations(agentRoot).filter((ob) => ob.status === "pending")
}

export function fulfillObligation(agentRoot: string, obligationId: string): void {
  const filePath = obligationFilePath(agentRoot, obligationId)
  let obligation: Obligation
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    obligation = JSON.parse(raw) as Obligation
  } catch {
    return
  }

  obligation.status = "fulfilled"
  obligation.fulfilledAt = new Date().toISOString()
  fs.writeFileSync(filePath, JSON.stringify(obligation, null, 2), "utf-8")

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
