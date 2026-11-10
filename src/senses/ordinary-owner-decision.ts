import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { isLocalMachineOwnerIdentity, machineOwnerUsername, type FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import type { ExternalEventOwnerMessage } from "../heart/external-events/router"

/**
 * The owner message of an ordinary agent's external-event ask or report. An
 * ordinary agent (no Sanctuary relationship registry) has no dedicated owner
 * channel, so the message goes the way surface sends it: to the owner's
 * freshest session through the agent's own senses, or as a deferred return
 * they see on their next contact. One message speaks for its whole batch.
 */

export interface OrdinaryOwnerDecisionInput {
  source: string
  eventId: string
  generation: number
  text: string
  relatedEvents: Array<{ source: string; eventId: string; generation: number }>
}

export interface OrdinaryOwnerDecisionDeps {
  agentName: string
  agentRoot: string
  listFriends: () => Promise<FriendRecord[]>
  route: (friendId: string, content: string) => Promise<{ status: "delivered" | "queued" | "deferred" | "failed"; detail?: string }>
  ownerUsername?: string | null
}

interface LedgerEntry {
  effectKey: string
  role: "sent" | "covered"
}

function ledgerPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "external-events", "ordinary-owner-messages.json")
}

function readLedger(agentRoot: string): Record<string, LedgerEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(agentRoot), "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, LedgerEntry> : {}
  } catch {
    return {}
  }
}

function writeLedger(agentRoot: string, ledger: Record<string, LedgerEntry>): void {
  const target = ledgerPath(agentRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
}

const eventKey = (event: { source: string; eventId: string; generation: number }): string =>
  `${event.source}\0${event.eventId}\0${event.generation}`

/**
 * The agent's owner: the active family friend who is this machine's OS user,
 * or else the only active family friend. Null when neither names one person.
 */
export function resolveOrdinaryOwner(friends: FriendRecord[], ownerUsername: string | null): FriendRecord | null {
  const family = friends.filter((friend) => friend.trustLevel === "family" && friend.admissionState !== "revoked")
  const local = family.filter((friend) => friend.externalIds.some((identity) => isLocalMachineOwnerIdentity(identity.provider, identity.externalId, ownerUsername)))
  if (local.length === 1) return local[0]!
  return family.length === 1 ? family[0]! : null
}

export async function deliverOrdinaryOwnerDecision(deps: OrdinaryOwnerDecisionDeps, input: OrdinaryOwnerDecisionInput): Promise<ExternalEventOwnerMessage> {
  const ledger = readLedger(deps.agentRoot)
  const existing = ledger[eventKey(input)]
  if (existing) return { status: existing.role === "covered" ? "covered" : "already_sent", effectKey: existing.effectKey }

  const owner = resolveOrdinaryOwner(await deps.listFriends(), deps.ownerUsername === undefined ? machineOwnerUsername() : deps.ownerUsername)
  if (!owner) throw new Error("this agent has no single owner to tell: no active family friend is this machine's user, and it has more or fewer than one family friend")
  const effectKey = `ordinary-owner:${crypto.createHash("sha256").update(eventKey(input)).digest("hex").slice(0, 32)}`
  const routed = await deps.route(owner.id, input.text)
  if (routed.status === "failed") throw new Error(`the owner message could not be delivered${routed.detail ? `: ${routed.detail}` : ""}`)

  ledger[eventKey(input)] = { effectKey, role: "sent" }
  for (const related of input.relatedEvents) ledger[eventKey(related)] ??= { effectKey, role: "covered" }
  writeLedger(deps.agentRoot, ledger)
  emitNervesEvent({
    component: "senses",
    event: "senses.ordinary_owner_decision_sent",
    message: "external-event owner message sent through the agent's own senses",
    meta: { agentName: deps.agentName, source: input.source, eventId: input.eventId, ownerId: owner.id, route: routed.status, related: input.relatedEvents.length },
  })
  return { status: "sent", effectKey }
}
