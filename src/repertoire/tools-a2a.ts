import * as path from "node:path"
import { getAgentRoot } from "../heart/identity"
import { isTrustedLevel } from "../mind/friends/types"
import type { FriendRecord } from "../mind/friends/types"
import { FileFriendStore } from "../mind/friends/store-file"
import type { FriendStore } from "../mind/friends/store"
import { emitNervesEvent } from "../nerves/runtime"
import { endpointForCard, fetchA2AAgentCard, getA2ATask, sendA2AMessage } from "../a2a/client"
import type { ToolContext, ToolDefinition } from "./tools-base"

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

export const a2aToolDefinitions: ToolDefinition[] = [
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
      try {
        const endpoint = await resolveA2AEndpoint(peer)
        const task = await sendA2AMessage({
          endpointUrl: endpoint.endpointUrl,
          message: args.message,
          senderAgentId: agentNameFromRoot(ctx?.agentRoot) ?? "ouro-agent",
          senderName: agentNameFromRoot(ctx?.agentRoot) ?? "Ouro agent",
          sessionKey: args.session_key,
        })
        return JSON.stringify(task, null, 2)
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
        const task = await getA2ATask({ endpointUrl: endpoint.endpointUrl, taskId: args.task_id })
        return JSON.stringify(task, null, 2)
      } catch (error) {
        return `A2A task error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error transport failures */ String(error)}`
      }
    },
    summaryKeys: ["friend_id", "task_id"],
  },
]
