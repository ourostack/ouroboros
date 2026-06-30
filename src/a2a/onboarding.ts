import * as path from "node:path"
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import type { FriendStore, FriendRecord, TrustLevel } from "@ouro.bot/friends"
import { parseDidKey, verifyCardDidBinding } from "@ouro.bot/friends/a2a-client"
import { endpointForCard, fetchA2AAgentCard } from "./client"
import type { A2AAgentCard } from "./types"

export interface OnboardA2APeerOptions {
  agentName: string
  cardUrl: string
  trustLevel?: TrustLevel
  name?: string
  bundlesRoot?: string
  store?: FriendStore
  fetchImpl?: typeof fetch
}

function storeFor(options: OnboardA2APeerOptions): FriendStore {
  if (options.store) return options.store
  /* v8 ignore next -- default bundle root fallback is owned by identity path tests; CLI and onboarding tests inject explicit roots @preserve */
  return new FileFriendStore(path.join(options.bundlesRoot ?? getAgentBundlesRoot(), `${options.agentName}.ouro`, "friends"))
}

/** The normalized card URL (legacy URL-keyed identity for did-less cards). */
function urlAgentId(cardUrl: string): string {
  const parsed = new URL(cardUrl)
  parsed.hash = ""
  return parsed.toString()
}

/** The trimmed `did:key` a card serves, or undefined when the card is did-less. */
function cardDid(card: A2AAgentCard): string | undefined {
  const did = card.did
  return typeof did === "string" && did.trim() ? did.trim() : undefined
}

export async function onboardA2APeer(options: OnboardA2APeerOptions): Promise<FriendRecord> {
  // HTTP/URL glue stays harness-side: fetch the agent card, resolve its JSON-RPC
  // endpoint, and derive the stable agentId. The record-shaping (mint/update the
  // agent-peer friend) is delegated to @ouro.bot/friends' upsertAgentPeer.
  const card = await fetchA2AAgentCard(options.cardUrl, options.fetchImpl)
  const store = storeFor(options)
  /* v8 ignore next -- fetchA2AAgentCard validates a usable endpoint or legacy url before returning a card @preserve */
  const endpointUrl = endpointForCard(card) ?? options.cardUrl
  const protocolVersion = card.supportedInterfaces?.find((entry) => entry.url === endpointUrl)?.protocolVersion
    ?? card.protocolVersion
  const name = options.name ?? card.name

  // THE FOOTGUN FIX: a DID-bearing card keys the record on its VERIFIED did:key
  // (so an inbound sealed envelope — keyed on the signed DID — resolves to THIS
  // record, not a stranger). A did-less (legacy) card keeps the URL-keyed identity
  // unchanged (backward compatible). For did:key the binding is self-contained
  // (`card.did === did`, `didDoc: null`); we ALSO require the served did:key to be a
  // well-formed, parseable Ed25519 key (a malformed did:key could never key/verify
  // an inbound envelope, so onboarding it would silently break the resolve later). A
  // card whose DID is unparseable or fails the binding is REFUSED (no record
  // written) — never TOFU-trust a mis-bound or malformed card.
  const did = cardDid(card)
  if (did) {
    const parsed = parseDidKey(did)
    const bound = parsed !== null && verifyCardDidBinding({ card: { did, url: options.cardUrl }, did, didDoc: null })
    if (!bound) {
      emitNervesEvent({
        component: "friends",
        event: "friends.a2a_card_binding_rejected",
        message: "refused A2A onboarding: card↔DID binding failed",
        meta: { agentName: options.agentName, cardUrl: options.cardUrl, did, parseable: parsed !== null },
      })
      throw new Error(`A2A card↔DID binding failed for ${did}`)
    }
  }

  // DID-keyed when present (externalId === did, a2a.did === did), else URL-keyed.
  const externalId = did ?? urlAgentId(options.cardUrl)
  const record = await upsertAgentPeer(store, {
    name,
    agentId: externalId,
    ...(options.trustLevel ? { trustLevel: options.trustLevel } : {}),
    a2a: {
      cardUrl: options.cardUrl,
      endpointUrl,
      agentId: externalId,
      protocolVersion,
      ...(did ? { did } : {}),
    },
  })

  emitNervesEvent({
    component: "friends",
    event: "friends.a2a_peer_onboarded",
    message: "onboarded A2A peer into friend model",
    meta: { agentName: options.agentName, friendId: record.id, peerName: record.name, trustLevel: record.trustLevel, ...(did ? { did } : {}) },
  })
  return record
}
