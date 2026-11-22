import * as path from "node:path"
import { getAgentRoot } from "../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { isTrustedLevel, FileFriendStore, authorizeConnect, connectAgents, prepareCoordination, prepareMissionResult, recordMission, findFriendByDid } from "@ouro.bot/friends"
import type { FriendRecord, FriendStore, SenseType, MissionRecord } from "@ouro.bot/friends"
import {
  ready,
  resolveReachability,
  sendShare,
  sealEnvelope,
  keyAgreementFromDidKey,
  parseDidKey,
  type DidKeyIdentity,
} from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import { endpointForCard, fetchA2AAgentCard, getA2ATask, sendA2AMessage } from "../a2a/client"
import { onboardA2APeer } from "../a2a/onboarding"
import { loadSelfA2AIdentity } from "../a2a/identity"
import { makeA2ATransport, type DeliveredRung } from "../a2a/transport"
import { markRelayContactStale, readRelayContact, refreshRelayContact, relayContactNeedsRefresh } from "../a2a/relay-contacts"
import { delegationStoresFor } from "../a2a/delegation-stores"
import { wrapMissionResultDataPart } from "../a2a/mission-result-wire"
import type { A2ATask } from "../a2a/types"
import { withCode, type ToolContext, type ToolDefinition } from "./tools-base"

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
  if (!ctx?.context?.friend?.id) return withCode("no friend context — cannot use A2A tools.", "no-friend-context")
  if (!isTrustedLevel(ctx.context.friend.trustLevel)) return withCode("A2A tools require friend or family trust.", "untrusted-requester")
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

/** Locate an imported delegation by its correlation `requestId` across all missions:
 * who delegated it (`fromAgentId`) + which local mission (`missionId`). The delegation
 * lives under `importedDelegations[fromAgentId][requestId]` — what the inbound bridge
 * quarantined. Returns undefined when no mission carries that requestId. */
function findImportedDelegation(missions: MissionRecord[], requestId: string): { fromAgentId: string; missionId: string } | undefined {
  for (const mission of missions) {
    for (const [fromAgentId, byRequest] of Object.entries(mission.importedDelegations ?? {})) {
      if (byRequest[requestId]) return { fromAgentId, missionId: mission.id }
    }
  }
  return undefined
}

/**
 * Seal an arbitrary friends plaintext envelope to a DID-keyed peer and deliver it over
 * the `direct` rung via friends' `sendShare`. `sendShare` builds the SAME SealedEnvelope
 * regardless of rung, `wrapInDataPart`-wraps it, and calls the transport itself; the
 * recipient X25519 is derived from the peer's pinned did:key. Throws when the peer's DID
 * is unparseable (cannot seal) or the rung is unreachable.
 */
async function sealEnvelopeToPeer(input: {
  agentRoot: string
  self: DidKeyIdentity
  sodium: Awaited<ReturnType<typeof ready>>
  peer: FriendRecord
  did: string
  envelope: Record<string, unknown>
  friendsKind: "coordination" | "profile_share" | "mission_share"
}): Promise<Delivery> {
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
  const relay = relayTransportFor(input)
  const result = await sendShare({
    sodium: input.sodium,
    transport: relay.transport,
    fromIdentity: input.self,
    toPeer: { a2a: input.peer.agentMeta?.a2a },
    recipientDid: input.did,
    recipientX25519Pub: keyAgreementFromDidKey({ sodium: input.sodium, ed25519Pub: parsed.ed25519Pub }),
    plaintextEnvelope: input.envelope,
    friendsKind: input.friendsKind,
  })
  /* v8 ignore next 3 -- unreachable behind the resolveReachability pre-check above: sendShare only returns ok:false on the SAME `unreachable` plan we already rejected; a redundant guard. @preserve */
  if (!result.ok) {
    throw new Error(`sealed send failed (${result.reason})`)
  }
  return relay.delivered()
}

/** Which rung carried a message, and whether a failed direct attempt may still have reached the peer. */
interface Delivery {
  rung: DeliveredRung
  directMayHaveArrived: boolean
}

/**
 * The transport for one send to a DID-keyed peer: direct first, then the relay contact the peer shared (if cached). A
 * relay that refuses the contact marks it stale. After a direct delivery, the peer is online, so its contact is
 * refreshed in the background when it is missing, stale or a day old.
 */
function relayTransportFor(input: { agentRoot: string; self: DidKeyIdentity; peer: FriendRecord; did: string }) {
  const cached = readRelayContact(input.agentRoot, input.did)
  let delivery: Delivery = { rung: "direct", directMayHaveArrived: false }
  const transport = makeA2ATransport({
    ...(cached?.contact ? { relayContact: cached.contact } : {}),
    onRelayContactRefused: () => markRelayContactStale(input.agentRoot, input.did),
    onDelivered: (rung, detail) => {
      delivery = { rung, directMayHaveArrived: detail?.directMayHaveArrived ?? false }
      const endpointUrl = input.peer.agentMeta?.a2a?.endpointUrl
      if (rung !== "direct" || !endpointUrl || !relayContactNeedsRefresh(cached, Date.now())) return
      const cardUrl = input.peer.agentMeta?.a2a?.cardUrl ?? new URL("/.well-known/agent-card.json", endpointUrl).toString()
      void refreshRelayContact({ agentRoot: input.agentRoot, peerDid: input.did, cardUrl, identity: input.self })
    },
  })
  return { transport, delivered: () => delivery }
}

/** The tool wording for a sealed delivery. */
function deliveryText(peerName: string, did: string, delivery: Delivery, what = "sealed message"): string {
  if (delivery.rung === "direct") return `${what} delivered to ${peerName} (${did}) over the direct rung.`
  const head = delivery.directMayHaveArrived ? `direct delivery to ${peerName} (${did}) failed and the ${what} may have arrived; a copy` : `${peerName} (${did}) is not reachable directly; the ${what}`
  return `${head} is queued at ${peerName}'s relay and is delivered when ${peerName} comes back online.`
}

/**
 * Seal an outbound free-text message to a DID-keyed peer over the `direct` rung. The
 * text rides a minimal `coordination` envelope (`intent:"offer"`, the text as `note`) —
 * the kind the Slice-1 inbound bridge verifies (signed sender DID) and turns into a
 * peer turn.
 */
async function sealAndSendToPeer(input: {
  agentName: string
  agentRoot: string
  peer: FriendRecord
  did: string
  message: string
}): Promise<Delivery> {
  const sodium = await ready()
  const self = await loadSelfA2AIdentity({ agentName: input.agentName, sodium })
  const envelope: Record<string, unknown> = {
    subject: { missionKey: `dm:${self.did}:${input.did}`, title: "Direct message" },
    fromAgentId: self.did,
    intent: "offer",
    note: input.message,
    issuedAt: new Date().toISOString(),
  }
  return await sealEnvelopeToPeer({
    agentRoot: input.agentRoot, self,
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
        return withCode(`connect_to is available only from your own local management sense (the CLI you launched). This sense (${senseType}) is not permitted to link agents.`, "not-local-sense")
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
        return withCode(`connect_to error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error failures @preserve */ String(error)}`, "connect-failed")
      }
    },
    ax: { id: "tool:connect_to", group: "a2a", when: "Pick this when your owner, at their own terminal, hands you another agent's card link to add as a trusted peer you can then message.", effect: "write", errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
      { code: "not-local-sense", means: "Linking agents works only from the owner's own CLI session, and this turn came from another sense.", fix: "Ask your owner to make the link in a CLI session with you, where connect_to is allowed." },
      { code: "connect-failed", means: "Fetching the card, checking its DID or saving the peer failed; the reason follows the colon.", fix: "Check card_url opens the agent's /.well-known/agent-card.json, then try once more." },
    ] },
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
      if (!listAll) return withCode("friend store does not support listing.", "no-peer-listing")
      const peers = (await listAll.call(store)).filter(isA2APeer)
      return JSON.stringify(peers.map((peer) => ({
        id: peer.id,
        name: peer.name,
        trustLevel: peer.trustLevel ?? "friend",
        endpointUrl: peer.agentMeta?.a2a?.endpointUrl,
        cardUrl: peer.agentMeta?.a2a?.cardUrl,
      })), null, 2)
    },
    ax: { id: "tool:a2a_list_peers", group: "a2a", when: "Pick this first when you need another agent's friend_id, or to see which agents you are linked with and how far each is trusted.", effect: "read", idempotent: true, errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
      { code: "no-peer-listing", means: "This friend store can't list its records, so no peers can be shown.", fix: "Use a friend_id you already know, or ask your owner which agents are linked." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
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
      if (!peer || !isA2APeer(peer)) return withCode(`A2A peer not found: ${args.friend_id}`, "peer-not-found")
      if (!isTrustedLevel(peer.trustLevel)) return withCode("target A2A peer must be friend or family trust before outbound messages.", "untrusted-peer")

      // ROUTING (explicit, no impl judgment): a DID-keyed peer → seal+sign via
      // sendShare over the direct rung (E2E, verified-DID inbound). A legacy peer
      // with no pinned DID → the existing text send, byte-for-byte unchanged.
      const did = peerDid(peer)
      if (did) {
        try {
          /* v8 ignore next -- in-turn a2a_send_message always carries a bundle agentRoot; the ambient-name fallback is defensive @preserve */
          const agentName = agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent"
          const delivery = await sealAndSendToPeer({
            agentName,
            /* v8 ignore next -- same defensive ambient fallback as agentName @preserve */
            agentRoot: ctx?.agentRoot ?? getAgentRoot(agentName),
            peer,
            did,
            message: args.message,
          })
          return deliveryText(peer.name, did, delivery)
        } catch (error) {
          return withCode(`A2A sealed send error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures @preserve */ String(error)}`, "send-failed")
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
        return withCode(`A2A send error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures */ String(error)}`, "send-failed")
      }
    },
    ax: { id: "tool:a2a_send_message", group: "a2a", when: "Pick this to say something to another agent or ask it a one-off favour; for tracked work on a shared mission, coordinate records the request.", effect: "write", errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
      { code: "peer-not-found", means: "friend_id names no onboarded A2A agent peer.", fix: "Call a2a_list_peers and pass one of the ids it shows." },
      { code: "untrusted-peer", means: "That agent peer is below friend trust, so I won't talk to it.", fix: "Ask your owner to raise the peer's trust, or pick a trusted peer from a2a_list_peers." },
      { code: "send-failed", means: "The message didn't reach the peer; the transport's reason follows the colon.", fix: "Try once more later; if it fails again, tell your owner that peer can't be reached." },
    ] },
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
      if (!peer || !isA2APeer(peer)) return withCode(`A2A peer not found: ${args.friend_id}`, "peer-not-found")
      if (!isTrustedLevel(peer.trustLevel)) return withCode("target A2A peer must be friend or family trust before task lookup.", "untrusted-peer")
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
        return withCode(`A2A task error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures */ String(error)}`, "task-fetch-failed")
      }
    },
    ax: { id: "tool:a2a_get_task", group: "a2a", when: "Pick this after a2a_send_message gave you a task id, to see whether the other agent has finished it and what it answered.", effect: "read", idempotent: true, errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
      { code: "peer-not-found", means: "friend_id names no onboarded A2A agent peer.", fix: "Call a2a_list_peers and pass one of the ids it shows." },
      { code: "untrusted-peer", means: "That agent peer is below friend trust, so I won't talk to it.", fix: "Ask your owner to raise the peer's trust, or pick a trusted peer from a2a_list_peers." },
      { code: "task-fetch-failed", means: "The peer didn't return the task; its reason follows the colon.", fix: "Check task_id came from that same peer's reply; pass access_token if an outside agent gave you one." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
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
      if (!peer || !isA2APeer(peer)) return withCode(`A2A peer not found: ${args.friend_id}`, "peer-not-found")
      if (!isTrustedLevel(peer.trustLevel)) return withCode("target A2A peer must be friend or family trust before delegating.", "untrusted-peer")
      const did = peerDid(peer)
      if (!did) return withCode("coordinate requires a DID-keyed peer (connect_to it first to pin its did:key).", "peer-not-did-keyed")

      /* v8 ignore next -- in-turn coordinate always carries a bundle agentRoot; the ambient-name fallback is defensive (same pattern as connect_to) @preserve */
      const agentName = agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent"
      const store = storeFor(ctx)
      /* v8 ignore next -- in-turn tool calls always carry an agentRoot; the getAgentRoot() ambient fallback depends on process argv (same pattern as storeFor) @preserve */
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
        /* v8 ignore next 3 -- unreachable for a trusted DID-keyed peer: recordMission guarantees the mission exists (no not_found) and the isTrustedLevel guard above guarantees trust≥friend, which the tiered consent default always approves (no no_consent). Defensive only. @preserve */
        if (!prepared.ok) {
          return `coordinate refused (${prepared.status}).`
        }
        const requestId = prepared.envelope.task?.requestId
        // Seal + send the coordination envelope to the peer over direct.
        const delivery = await sealEnvelopeToPeer({
          /* v8 ignore next -- in-turn coordinate always carries a bundle agentRoot; the ambient fallback is defensive @preserve */
          agentRoot: ctx?.agentRoot ?? getAgentRoot(agentName),
          self,
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
        const queued = delivery.rung === "relay" ? ` ${deliveryText(peer.name, did, delivery, "delegation")}` : ""
        return `coordinated: delegated "${args.task_summary}" to ${peer.name} on mission ${args.mission_key} (requestId ${requestId}).${queued}`
      } catch (error) {
        return withCode(`coordinate error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error failures @preserve */ String(error)}`, "coordinate-failed")
      }
    },
    ax: { id: "tool:coordinate", group: "a2a", when: "Pick this to hand a piece of work on a named shared mission to another agent and track it until it answers with send_result.", effect: "write", errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
      { code: "peer-not-found", means: "friend_id names no onboarded A2A agent peer.", fix: "Call a2a_list_peers and pass one of the ids it shows." },
      { code: "untrusted-peer", means: "That agent peer is below friend trust, so I won't talk to it.", fix: "Ask your owner to raise the peer's trust, or pick a trusted peer from a2a_list_peers." },
      { code: "peer-not-did-keyed", means: "The peer has no pinned did:key, so the request can't be sealed to it.", fix: "Ask your owner to link the peer again with connect_to, which pins its DID." },
      { code: "coordinate-failed", means: "Recording or sealing the delegation failed; the reason follows the colon.", fix: "Read the reason, fix what it names, and call coordinate again with the same mission_key." },
    ] },
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
      /* v8 ignore next -- in-turn tool calls always carry an agentRoot; the getAgentRoot() ambient fallback depends on process argv (same pattern as storeFor) @preserve */
      const { missionStore } = delegationStoresFor(ctx?.agentRoot ?? getAgentRoot())
      /* v8 ignore next -- FileMissionStore always implements listAll; the [] fallback guards a future store-shape regression @preserve */
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
    ax: { id: "tool:list_delegations", group: "a2a", when: "Pick this to check for jobs peers handed you before you start on them, and to find the requestId to answer with.", effect: "read", idempotent: true, errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
    ] },
    riskProfile: { mutates: "none", risk: "low" },
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "send_result",
        description: "Return a result for a delegation another agent sent you (by its requestId, from list_delegations). Seals the result and delivers it back to the delegating agent over the direct rung; they import it (assignee/correlation-gated). Deliver-back is explicit — do the work in your turn, then call this.",
        parameters: {
          type: "object",
          properties: {
            request_id: { type: "string", description: "The delegation correlation requestId (from list_delegations)." },
            summary: { type: "string", description: "A summary of the result/deliverable." },
            artifact: { type: "string", description: "Optional artifact reference (e.g. a PR or document URL)." },
          },
          required: ["request_id", "summary"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_send_result",
        message: "send_result invoked",
        meta: { tool: "send_result", requestId: args.request_id },
      })
      const guard = requireTrustedRequester(ctx)
      if (guard) return guard
      const store = storeFor(ctx)
      /* v8 ignore next -- in-turn tool calls always carry an agentRoot; the getAgentRoot() ambient fallback depends on process argv (same pattern as storeFor) @preserve */
      const { missionStore, grantStore } = delegationStoresFor(ctx?.agentRoot ?? getAgentRoot())

      // Find the imported delegation this result answers (who delegated + which mission).
      /* v8 ignore next -- FileMissionStore always implements listAll; the [] fallback guards a future store-shape regression @preserve */
      const missions: MissionRecord[] = missionStore.listAll ? await missionStore.listAll() : []
      const found = findImportedDelegation(missions, args.request_id)
      if (!found) return withCode(`no imported delegation found for requestId ${args.request_id} (check list_delegations).`, "delegation-not-found")

      // The delegator (the recipient of the result) must be a trusted, reachable,
      // DID-keyed peer in our store.
      const delegator = await findFriendByDid(store, found.fromAgentId)
      if (!delegator || !isA2APeer(delegator)) return withCode(`delegating peer not found for ${found.fromAgentId}.`, "delegator-not-found")
      if (!isTrustedLevel(delegator.trustLevel)) return withCode("delegating peer must be friend or family trust to return a result.", "untrusted-peer")
      const delegatorDid = peerDid(delegator)
      /* v8 ignore next -- unreachable: findFriendByDid matched this record BY its DID (via resolveAgentIdentity, which omits empty DIDs), so a2a.did is always present here. Defensive. @preserve */
      if (!delegatorDid) return "delegating peer is not DID-keyed (cannot seal the result)."
      const parsedDelegator = parseDidKey(delegatorDid)
      if (!parsedDelegator) return withCode(`cannot seal: delegating peer DID is unparseable (${delegatorDid}).`, "delegator-unreachable")
      const endpointUrl = delegator.agentMeta?.a2a?.endpointUrl
      if (!endpointUrl) return withCode("delegating peer has no reachable A2A endpoint to return the result to.", "delegator-unreachable")

      /* v8 ignore next -- in-turn send_result always carries a bundle agentRoot; the ambient-name fallback is defensive (same pattern as connect_to) @preserve */
      const agentName = agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent"
      try {
        const sodium = await ready()
        const self = await loadSelfA2AIdentity({ agentName, sodium })
        // prepareMissionResult records the result first-party (results[requestId]) +
        // returns the MissionResultEnvelope (consent-gated: trust ≥ friend recipient).
        const prepared = await prepareMissionResult(missionStore, store, grantStore, {
          missionId: found.missionId,
          toAgentId: delegatorDid,
          requestId: args.request_id,
          selfAgentId: self.did,
          result: { summary: args.summary, ...(args.artifact ? { artifact: args.artifact } : {}) },
        })
        /* v8 ignore next 3 -- unreachable for a trusted DID-keyed delegator: the mission exists (it carried the imported delegation we matched) and the isTrustedLevel guard guarantees trust≥friend, which the tiered consent default approves. Defensive only. @preserve */
        if (!prepared.ok) {
          return `send_result refused (${prepared.status}).`
        }

        // HARNESS-OWNED RESULT WIRE: seal the envelope (reusing the seal crypto), wrap
        // it in the mission_result-tagged DataPart, and POST it to the delegator over
        // direct. The inbound side routes it to importMissionResult (NOT receiveShare).
        const sealed = sealEnvelope({
          sodium,
          envelope: prepared.envelope as unknown as Record<string, unknown>,
          friendsKind: "coordination",
          fromIdentity: { did: self.did, keyId: self.keyId, ed25519Priv: self.ed25519Priv },
          recipientDid: delegatorDid,
          recipientX25519Pub: keyAgreementFromDidKey({ sodium, ed25519Pub: parsedDelegator.ed25519Pub }),
        })
        const message = wrapMissionResultDataPart({ sealedEnvelope: sealed, recipientDid: delegatorDid })
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_result_send",
          message: "delivering sealed mission result over the direct rung",
          meta: { selfDid: self.did, toDid: delegatorDid, requestId: args.request_id },
        })
        /* v8 ignore next -- in-turn send_result always carries a bundle agentRoot; the ambient fallback is defensive @preserve */
        const relay = relayTransportFor({ agentRoot: ctx?.agentRoot ?? getAgentRoot(agentName), self, peer: delegator, did: delegatorDid })
        await relay.transport.send({ rung: "direct", address: endpointUrl }, message as unknown as Parameters<typeof relay.transport.send>[1])
        const delivery = relay.delivered()
        return delivery.rung === "direct"
          ? `result sent to ${delegator.name} (${delegatorDid}) for requestId ${args.request_id}.`
          : `${deliveryText(delegator.name, delegatorDid, delivery, "result")} (requestId ${args.request_id})`
      } catch (error) {
        return withCode(`send_result error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error failures @preserve */ String(error)}`, "send-result-failed")
      }
    },
    ax: { id: "tool:send_result", group: "a2a", when: "Pick this once you have finished work another agent delegated to you, to deliver the outcome back against its requestId.", effect: "write", errors: [
      { code: "no-friend-context", means: "This turn has no friend behind it, so A2A tools can't tell who is asking.", fix: "Use A2A tools only on a turn that a known friend or family member started." },
      { code: "untrusted-requester", means: "The person on this turn is below friend trust, and A2A tools need friend or family.", fix: "Tell them you can't reach other agents for them; your owner can raise their trust." },
      { code: "delegation-not-found", means: "No delegation sent to you has that request_id.", fix: "Call list_delegations and pass the requestId it shows." },
      { code: "delegator-not-found", means: "The agent that sent the delegation isn't a linked peer any more.", fix: "Ask your owner to link that agent again with connect_to, then send the result." },
      { code: "untrusted-peer", means: "The delegating agent is below friend trust, so I won't send it the result.", fix: "Ask your owner whether to raise its trust before you send." },
      { code: "delegator-unreachable", means: "The delegating agent's DID can't be read or it has no A2A endpoint, so the result can't be delivered.", fix: "Ask your owner to link that agent again with connect_to, which refreshes its DID and endpoint." },
      { code: "send-result-failed", means: "Sealing or delivering the result failed; the reason follows the colon.", fix: "Try send_result once more; if it fails again, tell your owner the result is ready but undelivered." },
    ] },
    summaryKeys: ["request_id"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "returns a result to a remote agent peer" },
  },
]
