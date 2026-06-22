import * as path from "node:path"
import { getAgentRoot } from "../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { isTrustedLevel, FileFriendStore, authorizeConnect, connectAgents, prepareCoordination, recordMission } from "@ouro.bot/friends"
import type { FriendRecord, FriendStore, SenseType, MissionRecord } from "@ouro.bot/friends"
import {
  ready,
  resolveReachability,
  sendShare,
  keyAgreementFromDidKey,
  parseDidKey,
} from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import { endpointForCard, fetchA2AAgentCard, getA2ATask, sendA2AMessage } from "../a2a/client"
import { onboardA2APeer } from "../a2a/onboarding"
import { loadSelfA2AIdentity } from "../a2a/identity"
import { makeA2ATransport } from "../a2a/transport"
import { delegationStoresFor } from "../a2a/delegation-stores"
import type { A2ATask } from "../a2a/types"
import type { ToolContext, ToolDefinition } from "./tools-base"

const outboundTaskTokens = new Map<string, string>()

function tokenKey(ctx: ToolContext | undefined, friendId: string, taskId: string): string {
  return `${ctx?.agentRoot ?? "ambient"}\n${friendId}\n${taskId}`
}

function rememberTaskToken(ctx: ToolContext | undefined, friendId: string, task: A2ATask): void {
  /* v8 ignore next -- defensive metadata-shape guard; protocol tasks from Ouro servers always use object metadata @preserve */
  const token = task.metadata?.a2a && typeof task.metadata.a2a === "object" && !Array.isArray(task.metadata.a2a)
    ? (task.metadata.a2a as { accessToken?: unknown }).accessToken
    : undefined
  if (typeof token === "string" && token.trim()) {
    outboundTaskTokens.set(tokenKey(ctx, friendId, task.id), token.trim())
  }
}

function rememberedTaskToken(ctx: ToolContext | undefined, friendId: string, taskId: string): string | undefined {
  return outboundTaskTokens.get(tokenKey(ctx, friendId, taskId))
}

function redactTaskToken(task: A2ATask): A2ATask {
  const a2a = task.metadata?.a2a
  if (!a2a || typeof a2a !== "object" || Array.isArray(a2a) || !("accessToken" in a2a)) return task
  const { accessToken: _accessToken, ...safeA2A } = a2a as Record<string, unknown>
  return {
    ...task,
    metadata: {
      ...task.metadata,
      a2a: safeA2A,
    },
  }
}

function storeFor(ctx?: ToolContext): FriendStore {
  if (ctx?.friendStore) return ctx.friendStore
  /* v8 ignore next -- no-agentRoot fallback depends on process argv; normal tool calls inject agentRoot @preserve */
  if (ctx?.agentRoot) return new FileFriendStore(path.join(ctx.agentRoot, "friends"))
  return new FileFriendStore(path.join(getAgentRoot(), "friends"))
}

function requireTrustedRequester(ctx?: ToolContext): string | null {
  if (!ctx?.context?.friend?.id) return "no friend context — cannot use A2A tools."
  if (!isTrustedLevel(ctx.context.friend.trustLevel)) return "A2A tools require friend or family trust."
  return null
}

function isA2APeer(friend: FriendRecord): boolean {
  return friend.kind === "agent" && friend.externalIds.some((id) => id.provider === "a2a-agent")
}

function agentNameFromRoot(agentRoot: string | undefined): string | undefined {
  if (!agentRoot) return undefined
  const base = path.basename(agentRoot)
  return base.endsWith(".ouro") ? base.slice(0, -".ouro".length) : undefined
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function localA2ACardUrl(agentRoot: string | undefined): string | undefined {
  const agentName = agentNameFromRoot(agentRoot)
  if (!agentName) return undefined
  const result = readMachineRuntimeCredentialConfig(agentName)
  if (!result.ok) return undefined
  const a2a = result.config.a2a
  if (!a2a || typeof a2a !== "object" || Array.isArray(a2a)) return undefined
  const publicUrl = textField(a2a as Record<string, unknown>, "publicUrl")
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/.well-known/agent-card.json` : undefined
}

async function resolveA2AEndpoint(friend: FriendRecord): Promise<{ endpointUrl: string; agentId?: string; peerName: string }> {
  const metadata = friend.agentMeta?.a2a
  if (metadata?.endpointUrl) {
    return { endpointUrl: metadata.endpointUrl, agentId: metadata.agentId, peerName: friend.name }
  }
  if (metadata?.cardUrl) {
    const card = await fetchA2AAgentCard(metadata.cardUrl)
    const endpointUrl = endpointForCard(card)
    /* v8 ignore next -- fetchA2AAgentCard rejects cards without a usable endpoint before tools see them @preserve */
    if (!endpointUrl) throw new Error("A2A card has no JSONRPC endpoint")
    /* v8 ignore next -- empty card names are invalid in practice; friend-name fallback is defensive @preserve */
    const peerName = card.name || friend.name
    return { endpointUrl, agentId: metadata.agentId ?? endpointUrl, peerName }
  }
  const external = friend.externalIds.find((id) => id.provider === "a2a-agent")
  if (external?.externalId?.startsWith("http")) {
    const card = await fetchA2AAgentCard(external.externalId)
    const endpointUrl = endpointForCard(card)
    /* v8 ignore next -- fetchA2AAgentCard rejects cards without a usable endpoint before tools see them @preserve */
    if (!endpointUrl) throw new Error("A2A card has no JSONRPC endpoint")
    /* v8 ignore next -- empty card names are invalid in practice; friend-name fallback is defensive @preserve */
    const peerName = card.name || friend.name
    return { endpointUrl, agentId: external.externalId, peerName }
  }
  throw new Error("A2A peer has no endpointUrl or cardUrl in agentMeta.a2a")
}

/** The management sense the current turn arrived through, defaulting to a non-`local`
 * value when unknown so the owner-only gate fails CLOSED on an unexpected origin. */
function senseTypeOf(ctx?: ToolContext): SenseType {
  /* v8 ignore next -- in-turn tool calls always carry a resolved channel context; the open-default fail-closed fallback is defensive @preserve */
  return ctx?.context?.channel?.senseType ?? "open"
}

/** The pinned DID a peer record carries (its durable A2A identity), or undefined for a
 * legacy (non-DID-keyed) peer. */
function peerDid(peer: FriendRecord): string | undefined {
  const did = peer.agentMeta?.a2a?.did
  return typeof did === "string" && did.trim() ? did.trim() : undefined
}

/**
 * Seal an arbitrary friends plaintext envelope to a DID-keyed peer and deliver it over
 * the `direct` rung via friends' `sendShare`. `sendShare` builds the SAME SealedEnvelope
 * regardless of rung, `wrapInDataPart`-wraps it, and calls the transport itself; the
 * recipient X25519 is derived from the peer's pinned did:key. Throws when the peer's DID
 * is unparseable (cannot seal) or the rung is unreachable.
 */
async function sealEnvelopeToPeer(input: {
  self: { did: string; keyId: string; ed25519Priv: Uint8Array }
  sodium: Awaited<ReturnType<typeof ready>>
  peer: FriendRecord
  did: string
  envelope: Record<string, unknown>
  friendsKind: "coordination" | "profile_share" | "mission_share"
}): Promise<void> {
  const parsed = parseDidKey(input.did)
  if (!parsed) throw new Error(`cannot seal: peer DID is not a parseable did:key (${input.did})`)
  const reachability = resolveReachability(input.peer.agentMeta?.a2a, input.peer.agentMeta?.mailbox)
  if (reachability.rung === "unreachable") {
    throw new Error("cannot seal: peer has no reachable A2A endpoint")
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_outbound_seal",
    message: "sealing outbound A2A envelope to a DID-keyed peer",
    meta: { selfDid: input.self.did, peerDid: input.did, rung: reachability.rung, friendsKind: input.friendsKind },
  })
  const result = await sendShare({
    sodium: input.sodium,
    transport: makeA2ATransport(),
    fromIdentity: input.self,
    toPeer: { a2a: input.peer.agentMeta?.a2a },
    recipientDid: input.did,
    recipientX25519Pub: keyAgreementFromDidKey({ sodium: input.sodium, ed25519Pub: parsed.ed25519Pub }),
    plaintextEnvelope: input.envelope,
    friendsKind: input.friendsKind,
  })
  if (!result.ok) {
    throw new Error(`sealed send failed (${result.reason})`)
  }
}

/**
 * Seal an outbound free-text message to a DID-keyed peer over the `direct` rung. The
 * text rides a minimal `coordination` envelope (`intent:"offer"`, the text as `note`) —
 * the kind the Slice-1 inbound bridge verifies (signed sender DID) and turns into a
 * peer turn.
 */
async function sealAndSendToPeer(input: {
  agentName: string
  peer: FriendRecord
  did: string
  message: string
  sessionKey?: string
}): Promise<void> {
  const sodium = await ready()
  const self = await loadSelfA2AIdentity({ agentName: input.agentName, sodium })
  const envelope: Record<string, unknown> = {
    subject: { missionKey: `dm:${self.did}:${input.did}`, title: "Direct message" },
    fromAgentId: self.did,
    intent: "offer",
    note: input.message,
    issuedAt: new Date().toISOString(),
  }
  await sealEnvelopeToPeer({
    self: { did: self.did, keyId: self.keyId, ed25519Priv: self.ed25519Priv },
    sodium, peer: input.peer, did: input.did, envelope, friendsKind: "coordination",
  })
}

export const a2aToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "connect_to",
        description: "Owner-only: link an A2A agent (by its agent-card URL) into your fleet as a family-trusted, DID-keyed peer. Reachable only from your own local/CLI management sense — not exposed to network peers.",
        parameters: {
          type: "object",
          properties: {
            card_url: { type: "string", description: "The agent-card URL of the agent to connect to (its /.well-known/agent-card.json)." },
            name: { type: "string", description: "Optional display name for the linked peer (defaults to the card name)." },
          },
          required: ["card_url"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_connect_to",
        message: "connect_to invoked",
        meta: { tool: "connect_to" },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard

      // OWNER-ONLY GATE (fail-closed): authorizeConnect commits ONLY on the `local`
      // (owner stdio/CLI) management sense. Any network/group/internal sense
      // downgrades — refused BEFORE any card fetch or record write, so this tool is
      // never reachable as a general in-turn capability a network peer could exercise.
      // No `membership` is computed (roster auto-family is OUT of scope), so a `closed`
      // sense ALSO downgrades — never a blanket-allow without the real roster verifier.
      const senseType = senseTypeOf(ctx)
      const authorization = authorizeConnect({ senseType })
      if (authorization.decision !== "commit") {
        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.tool_connect_to_refused",
          message: "connect_to refused (non-owner management sense)",
          meta: { tool: "connect_to", senseType, reason: authorization.reason },
        })
        return `connect_to is available only from your own local management sense (the CLI you launched). This sense (${senseType}) is not permitted to link agents.`
      }

      const agentName = agentNameFromRoot(ctx?.agentRoot)
      // ONE store for both halves — the DID-keyed onboarding write and the
      // connectAgents resolve/link MUST point at the same store, or the link can't
      // resolve the record the onboarding just wrote.
      const store = storeFor(ctx)
      try {
        // 1) DID-keyed onboarding (the footgun fix): fetch the card, verify the
        //    card↔DID binding, and write the record keyed on the verified DID. This
        //    is what makes the peer resolvable BY DID for connectAgents below (and for
        //    the inbound resolve path). A mis-bound card throws here → no link.
        const onboarded = await onboardA2APeer({
          /* v8 ignore next -- in-turn connect_to always carries an agentRoot; the ambient-name fallback is defensive @preserve */
          agentName: agentName ?? "ouro-agent",
          cardUrl: args.card_url,
          trustLevel: "family",
          ...(args.name ? { name: args.name } : {}),
          store,
        })
        const did = onboarded.agentMeta?.a2a?.did
        // onboardA2APeer always sets a2a.agentId (== the DID when DID-keyed, else the
        // card URL), so this is the resolvable handle connectAgents disambiguates on.
        /* v8 ignore next -- upsertAgentPeer always writes a2a.agentId; the record-id fallback guards a future store-shape regression @preserve */
        const peerHandle = onboarded.agentMeta?.a2a?.agentId ?? onboarded.id

        // 2) The authority-gated link + control-plane audit. connectAgents re-runs the
        //    `local` gate, resolves the just-written record (by DID when present, else
        //    by its agent-peer handle), links at family, and records action:"connect".
        const result = await connectAgents(
          store,
          {
            peer: did ? { did } : { agentId: peerHandle },
            senseType,
            trustLevel: "family",
          },
          { actor: "owner:local", originSense: senseType },
        )
        /* v8 ignore next 3 -- onboardA2APeer wrote a DID/agentId-keyed record, so connectAgents always resolves it (ok:true); this guards a future store-shape regression @preserve */
        if (!result.ok) {
          return `connect_to could not complete the link (${result.status}).`
        }
        return `connected ${result.record.name} (${did ?? result.record.id}) at family trust.`
      } catch (error) {
        return `connect_to error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error failures @preserve */ String(error)}`
      }
    },
    summaryKeys: ["card_url", "name"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "links a new agent peer into the friend model at family trust" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "a2a_list_peers",
        description: "List onboarded A2A agent peers from the friend model. Requires friend or family trust.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async (_args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_a2a_list_peers",
        message: "a2a_list_peers invoked",
        meta: { tool: "a2a_list_peers" },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard
      const store = storeFor(ctx)
      const listAll = store.listAll
      if (!listAll) return "friend store does not support listing."
      const peers = (await listAll.call(store)).filter(isA2APeer)
      return JSON.stringify(peers.map((peer) => ({
        id: peer.id,
        name: peer.name,
        trustLevel: peer.trustLevel ?? "friend",
        endpointUrl: peer.agentMeta?.a2a?.endpointUrl,
        cardUrl: peer.agentMeta?.a2a?.cardUrl,
      })), null, 2)
    },
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "a2a_send_message",
        description: "Send a message to a trusted A2A agent peer. The target peer must be an agent friend at friend/family trust.",
        parameters: {
          type: "object",
          properties: {
            friend_id: { type: "string", description: "Friend record ID for the A2A agent peer." },
            message: { type: "string", description: "Message or task request to send." },
            session_key: { type: "string", description: "Optional A2A context/session key." },
          },
          required: ["friend_id", "message"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_a2a_send_message",
        message: "a2a_send_message invoked",
        meta: { tool: "a2a_send_message", friendId: args.friend_id },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard
      const peer = await storeFor(ctx).get(args.friend_id)
      if (!peer || !isA2APeer(peer)) return `A2A peer not found: ${args.friend_id}`
      if (!isTrustedLevel(peer.trustLevel)) return "target A2A peer must be friend or family trust before outbound messages."

      // ROUTING (explicit, no impl judgment): a DID-keyed peer → seal+sign via
      // sendShare over the direct rung (E2E, verified-DID inbound). A legacy peer
      // with no pinned DID → the existing text send, byte-for-byte unchanged.
      const did = peerDid(peer)
      if (did) {
        try {
          await sealAndSendToPeer({
            agentName: agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent",
            peer,
            did,
            message: args.message,
            ...(args.session_key ? { sessionKey: args.session_key } : {}),
          })
          return `sealed message delivered to ${peer.name} (${did}) over the direct rung.`
        } catch (error) {
          return `A2A sealed send error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures @preserve */ String(error)}`
        }
      }

      try {
        const endpoint = await resolveA2AEndpoint(peer)
        const task = await sendA2AMessage({
          endpointUrl: endpoint.endpointUrl,
          message: args.message,
          senderAgentId: agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent",
          senderName: agentNameFromRoot(ctx?.agentRoot) ?? "Ouro agent",
          senderCardUrl: localA2ACardUrl(ctx?.agentRoot),
          sessionKey: args.session_key,
        })
        rememberTaskToken(ctx, peer.id, task)
        return JSON.stringify(redactTaskToken(task), null, 2)
      } catch (error) {
        return `A2A send error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures */ String(error)}`
      }
    },
    summaryKeys: ["friend_id", "session_key"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends a message to a remote agent peer" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "a2a_get_task",
        description: "Fetch a task from a trusted A2A agent peer.",
        parameters: {
          type: "object",
          properties: {
            friend_id: { type: "string", description: "Friend record ID for the A2A agent peer." },
            task_id: { type: "string", description: "Remote A2A task ID." },
            access_token: { type: "string", description: "Optional task access token from an external A2A response; omitted for tasks sent through a2a_send_message because Ouro stores it out of transcript." },
          },
          required: ["friend_id", "task_id"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_a2a_get_task",
        message: "a2a_get_task invoked",
        meta: { tool: "a2a_get_task", friendId: args.friend_id, taskId: args.task_id },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard
      const peer = await storeFor(ctx).get(args.friend_id)
      if (!peer || !isA2APeer(peer)) return `A2A peer not found: ${args.friend_id}`
      if (!isTrustedLevel(peer.trustLevel)) return "target A2A peer must be friend or family trust before task lookup."
      try {
        const endpoint = await resolveA2AEndpoint(peer)
        const task = await getA2ATask({
          endpointUrl: endpoint.endpointUrl,
          taskId: args.task_id,
          accessToken: args.access_token ?? rememberedTaskToken(ctx, peer.id, args.task_id),
          senderAgentId: agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent",
          senderName: agentNameFromRoot(ctx?.agentRoot) ?? "Ouro agent",
          senderCardUrl: localA2ACardUrl(ctx?.agentRoot),
        })
        rememberTaskToken(ctx, peer.id, task)
        return JSON.stringify(redactTaskToken(task), null, 2)
      } catch (error) {
        return `A2A task error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures */ String(error)}`
      }
    },
    summaryKeys: ["friend_id", "task_id"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "coordinate",
        description: "Delegate a task to a trusted (friend/family) A2A agent peer over a named shared mission. Mints a correlation requestId, records your first-party delegation, and seals the coordination to the peer over the direct rung. The peer reads it via its quarantined imported delegations and returns a result with send_result.",
        parameters: {
          type: "object",
          properties: {
            friend_id: { type: "string", description: "Friend record ID for the A2A agent peer to delegate to." },
            mission_key: { type: "string", description: "The shared mission join key both agents can name (e.g. a stable project key)." },
            mission_title: { type: "string", description: "Human title for the mission (used when first creating it)." },
            task_summary: { type: "string", description: "What the peer is being asked to do." },
            task_details: { type: "string", description: "Optional fuller description of the task." },
          },
          required: ["friend_id", "mission_key", "mission_title", "task_summary"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_coordinate",
        message: "coordinate invoked",
        meta: { tool: "coordinate", friendId: args.friend_id, missionKey: args.mission_key },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard
      const peer = await storeFor(ctx).get(args.friend_id)
      if (!peer || !isA2APeer(peer)) return `A2A peer not found: ${args.friend_id}`
      if (!isTrustedLevel(peer.trustLevel)) return "target A2A peer must be friend or family trust before delegating."
      const did = peerDid(peer)
      if (!did) return "coordinate requires a DID-keyed peer (connect_to it first to pin its did:key)."

      const agentName = agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent"
      const store = storeFor(ctx)
      const { missionStore, grantStore } = delegationStoresFor(ctx?.agentRoot ?? getAgentRoot())
      try {
        const sodium = await ready()
        const self = await loadSelfA2AIdentity({ agentName, sodium })
        // Ensure the local mission exists (first-party), then prepare the coordination:
        // mints the requestId + records the first-party delegation (assignee = the peer).
        const mission = await recordMission(missionStore, { missionKey: args.mission_key, title: args.mission_title })
        const prepared = await prepareCoordination(missionStore, store, grantStore, {
          missionId: mission.id,
          toAgentId: did,
          intent: "request",
          selfAgentId: self.did,
          task: { summary: args.task_summary, ...(args.task_details ? { details: args.task_details } : {}) },
        })
        if (!prepared.ok) {
          return `coordinate refused (${prepared.status}).`
        }
        const requestId = prepared.envelope.task?.requestId
        // Seal + send the coordination envelope to the peer over direct.
        await sealEnvelopeToPeer({
          self: { did: self.did, keyId: self.keyId, ed25519Priv: self.ed25519Priv },
          sodium, peer, did,
          envelope: prepared.envelope as unknown as Record<string, unknown>,
          friendsKind: "coordination",
        })
        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.tool_coordinate_sent",
          message: "coordination delegated + sealed to peer",
          meta: { tool: "coordinate", peerDid: did, missionKey: args.mission_key, requestId },
        })
        return `coordinated: delegated "${args.task_summary}" to ${peer.name} on mission ${args.mission_key} (requestId ${requestId}).`
      } catch (error) {
        return `coordinate error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error failures @preserve */ String(error)}`
      }
    },
    summaryKeys: ["friend_id", "mission_key"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "delegates a task to a remote agent peer" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "list_delegations",
        description: "List delegations other agents have sent you (quarantined imported delegations). Each entry names the requesting agent, the mission, the correlation requestId, and the task summary. Use this to see what work peers have asked you to do, then send_result when done.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async (_args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_list_delegations",
        message: "list_delegations invoked",
        meta: { tool: "list_delegations" },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard
      const { missionStore } = delegationStoresFor(ctx?.agentRoot ?? getAgentRoot())
      const missions: MissionRecord[] = missionStore.listAll ? await missionStore.listAll() : []
      const rows: Array<{ requestId: string; fromAgentId: string; missionKey: string; missionTitle: string; summary: string; details?: string }> = []
      for (const mission of missions) {
        for (const [fromAgentId, byRequest] of Object.entries(mission.importedDelegations ?? {})) {
          for (const [requestId, delegation] of Object.entries(byRequest)) {
            rows.push({
              requestId,
              fromAgentId,
              missionKey: mission.missionKey,
              missionTitle: mission.title,
              summary: delegation.task.summary,
              ...(delegation.task.details ? { details: delegation.task.details } : {}),
            })
          }
        }
      }
      return JSON.stringify(rows, null, 2)
    },
    summaryKeys: [],
  },
]
