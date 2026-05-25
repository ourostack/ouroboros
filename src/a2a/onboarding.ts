import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { FileFriendStore } from "../mind/friends/store-file"
import type { FriendStore } from "../mind/friends/store"
import type { FriendRecord, TrustLevel } from "../mind/friends/types"
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
  return new FileFriendStore(path.join(options.bundlesRoot ?? getAgentBundlesRoot(), `${options.agentName}.ouro`, "friends"))
}

function agentIdFor(card: A2AAgentCard, cardUrl: string): string {
  const metadata = card.metadata as { ouro?: { agentName?: unknown } } | undefined
  const ouroAgentName = typeof metadata?.ouro?.agentName === "string" ? metadata.ouro.agentName : undefined
  return ouroAgentName ?? endpointForCard(card) ?? cardUrl
}

export async function onboardA2APeer(options: OnboardA2APeerOptions): Promise<FriendRecord> {
  const card = await fetchA2AAgentCard(options.cardUrl, options.fetchImpl)
  const store = storeFor(options)
  const now = new Date().toISOString()
  const externalId = agentIdFor(card, options.cardUrl)
  const endpointUrl = endpointForCard(card) ?? options.cardUrl
  const protocolVersion = card.supportedInterfaces?.find((entry) => entry.url === endpointUrl)?.protocolVersion
    ?? card.protocolVersion
  const existing = await store.findByExternalId("a2a-agent", externalId)
  const name = options.name ?? card.name
  const trustLevel = options.trustLevel ?? existing?.trustLevel ?? "acquaintance"
  const baseMeta = existing?.agentMeta ?? {
    bundleName: name,
    familiarity: 0,
    sharedMissions: [],
    outcomes: [],
  }
  const record: FriendRecord = {
    ...(existing ?? {
      id: randomUUID(),
      createdAt: now,
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      schemaVersion: 1,
    }),
    name,
    role: "agent-peer",
    trustLevel,
    kind: "agent",
    agentMeta: {
      ...baseMeta,
      bundleName: baseMeta.bundleName || name,
      a2a: {
        cardUrl: options.cardUrl,
        endpointUrl,
        agentId: externalId,
        protocolVersion,
      },
    },
    externalIds: [
      ...(existing?.externalIds.filter((id) => !(id.provider === "a2a-agent" && id.externalId === externalId)) ?? []),
      { provider: "a2a-agent", externalId, linkedAt: now },
    ],
    updatedAt: now,
  }
  await store.put(record.id, record)
  emitNervesEvent({
    component: "friends",
    event: "friends.a2a_peer_onboarded",
    message: "onboarded A2A peer into friend model",
    meta: { agentName: options.agentName, friendId: record.id, peerName: record.name, trustLevel },
  })
  return record
}
