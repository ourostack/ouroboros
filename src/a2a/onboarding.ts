import * as path from "node:path"
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import type { FriendStore, FriendRecord, TrustLevel } from "@ouro.bot/friends"
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

function agentIdFor(_card: A2AAgentCard, cardUrl: string): string {
  const parsed = new URL(cardUrl)
  parsed.hash = ""
  return parsed.toString()
}

export async function onboardA2APeer(options: OnboardA2APeerOptions): Promise<FriendRecord> {
  // HTTP/URL glue stays harness-side: fetch the agent card, resolve its JSON-RPC
  // endpoint, and derive the stable agentId. The record-shaping (mint/update the
  // agent-peer friend) is delegated to @ouro.bot/friends' upsertAgentPeer.
  const card = await fetchA2AAgentCard(options.cardUrl, options.fetchImpl)
  const store = storeFor(options)
  const externalId = agentIdFor(card, options.cardUrl)
  /* v8 ignore next -- fetchA2AAgentCard validates a usable endpoint or legacy url before returning a card @preserve */
  const endpointUrl = endpointForCard(card) ?? options.cardUrl
  const protocolVersion = card.supportedInterfaces?.find((entry) => entry.url === endpointUrl)?.protocolVersion
    ?? card.protocolVersion
  const name = options.name ?? card.name

  const record = await upsertAgentPeer(store, {
    name,
    agentId: externalId,
    ...(options.trustLevel ? { trustLevel: options.trustLevel } : {}),
    a2a: {
      cardUrl: options.cardUrl,
      endpointUrl,
      agentId: externalId,
      protocolVersion,
    },
  })

  emitNervesEvent({
    component: "friends",
    event: "friends.a2a_peer_onboarded",
    message: "onboarded A2A peer into friend model",
    meta: { agentName: options.agentName, friendId: record.id, peerName: record.name, trustLevel: record.trustLevel },
  })
  return record
}
