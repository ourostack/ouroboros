import { createHash } from "node:crypto"

import { cardDid, fetchA2AAgentCard, sendSealedA2AChat } from "../a2a/client"
import { loadSelfA2AIdentity } from "../a2a/identity"
import { loadAgentConfig } from "../heart/identity"
import type { DidKeyIdentity } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The Butler's messages that it starts itself (house notices, external events, unprompted messages) go to Ari's primary
 * agent over A2A instead of to Ari's Telegram, so one bot decides what reaches his phone (Ari, 2026-11-22: "my desired
 * end state is to only be getting notifications on my phone by the one primary bot"). Replies to Ari stay on Telegram.
 */

export type OwnerRouteUrgency = "now" | "today" | "batch"

export interface OwnerRouteItem {
  /** The Telegram idempotency key the message would have gone out under. */
  key: string
  text: string
  urgency: OwnerRouteUrgency
  /** One per condition, so a re-fire updates the peer's item instead of adding one. */
  dedupeKey: string
}

export type OwnerRouteOutcome = { status: "delivered" } | { status: "unreachable"; detail: string }
export type OwnerRoute = ((item: OwnerRouteItem) => Promise<OwnerRouteOutcome>) & {
  /** Checks that the peer answers as itself, sending nothing. */
  probe?: () => Promise<OwnerRouteOutcome>
}

/** How often the Butler checks the peer, and how many failed checks in a row (15 minutes) count as down. */
export const OWNER_ROUTE_WATCH_INTERVAL_MS = 5 * 60_000
export const OWNER_ROUTE_WATCH_FAILURES = 3
export const OWNER_ROUTE_DOWN_TEXT = "Slugger (your phone bot) has been unreachable for 15 min; agents can't reach you through him."
export const OWNER_ROUTE_BACK_TEXT = "Slugger is reachable again, so agents reach you through him as before."

export const OWNER_ROUTE_FALLBACK_PREFIX = "Slugger can't be reached, so this comes to you directly."

export function ownerRouteUrgency(key: string, critical: boolean): OwnerRouteUrgency {
  if (critical) return "now"
  if (key.startsWith("owner-notice:house-sweep:")) return "batch"
  return "today"
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")

export function ownerRouteDedupeKey(key: string, text: string): string {
  const [kind, ...rest] = key.split(":")
  const tail = rest.join(":")
  let condition: string
  if (kind === "external-event") {
    // The generation counts re-fires of one event; the condition is its source and id.
    let identity: unknown
    try { identity = JSON.parse(tail) } catch { identity = null }
    condition = Array.isArray(identity) && identity.length >= 2 ? `${identity[0]}-${identity[1]}` : key
  } else if (kind === "proactive") {
    // A proactive key is a fresh UUID each time, so the same words name the same condition.
    condition = `proactive-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`
  } else {
    condition = kind === "owner-notice" ? tail : key
  }
  return `butler-${slug(condition)}`.slice(0, 120)
}

export function ownerRouteItem(key: string, text: string, critical: boolean): OwnerRouteItem {
  return { key, text, urgency: ownerRouteUrgency(key, critical), dedupeKey: ownerRouteDedupeKey(key, text) }
}

export function formatOwnerRouteMessage(item: OwnerRouteItem): string {
  const firstLine = item.text.trim().split("\n")[0]!.trim()
  const ask = firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine
  return [
    "from: the Butler (sanctuary, Ari's house server)",
    `urgency: ${item.urgency}`,
    `ask: ${ask}`,
    "why only Ari: it is about his house, and the Butler reports to him",
    `steps: ${item.text}`,
    "deadline: none",
    `dedupe key: ${item.dedupeKey}`,
  ].join("\n")
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createA2AOwnerRoute(options: {
  cardUrl: string
  /** The peer's DID, pinned: a card at that address under another key is refused. */
  did: string
  loadIdentity: () => Promise<DidKeyIdentity>
  fetchCard?: typeof fetchA2AAgentCard
  send?: typeof sendSealedA2AChat
}): OwnerRoute {
  const fetchCard = options.fetchCard ?? fetchA2AAgentCard
  const send = options.send ?? sendSealedA2AChat
  /** null when the card at the address serves the pinned DID; otherwise why not. */
  const pinned = async (): Promise<string | null> => {
    const served = cardDid(await fetchCard(options.cardUrl))
    if (served === options.did) return null
    emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_owner_route_pin_mismatch", message: "the owner route's peer card serves another DID", meta: { cardUrl: options.cardUrl, served: served ?? null, pinned: options.did } })
    return `the card at ${options.cardUrl} serves ${served}, not the pinned ${options.did}`
  }
  const probe = async (): Promise<OwnerRouteOutcome> => {
    try {
      const detail = await pinned()
      return detail ? { status: "unreachable", detail } : { status: "delivered" }
    } catch (error) {
      return { status: "unreachable", detail: reason(error) }
    }
  }
  const route = async (item: OwnerRouteItem): Promise<OwnerRouteOutcome> => {
    try {
      const detail = await pinned()
      if (detail) return { status: "unreachable", detail }
      await send({ cardUrl: options.cardUrl, text: formatOwnerRouteMessage(item), identity: await options.loadIdentity() })
      emitNervesEvent({ component: "senses", event: "senses.telegram_owner_route_delivered", message: "sent a self-started Butler message to the owner's primary agent", meta: { urgency: item.urgency, dedupeKey: item.dedupeKey } })
      return { status: "delivered" }
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.telegram_owner_route_unreachable", message: "the owner's primary agent could not be reached", meta: { urgency: item.urgency, dedupeKey: item.dedupeKey, error: reason(error) } })
      return { status: "unreachable", detail: reason(error) }
    }
  }
  return Object.assign(route, { probe })
}

/** The owner route `agent.json` names (`senses.telegram.ownerNoticesTo`), signing as this agent's A2A identity; none when unset. */
export function ownerRouteForAgent(agentName: string, agentRoot: string): OwnerRoute | undefined {
  const peer = loadAgentConfig({ agentName, agentRoot }).senses?.telegram.ownerNoticesTo
  emitNervesEvent({ component: "senses", event: "senses.telegram_owner_route_configured", message: "read the Telegram owner route", meta: { agentName, cardUrl: peer?.cardUrl ?? null } })
  if (!peer) return undefined
  return createA2AOwnerRoute({ cardUrl: peer.cardUrl, did: peer.did, loadIdentity: () => loadSelfA2AIdentity({ agentName }) })
}
