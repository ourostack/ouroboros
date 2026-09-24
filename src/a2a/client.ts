import { randomUUID } from "node:crypto"
import { parseDidKey, ready, verifyCardDidBinding, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import { openChatMessage, sealChatMessage } from "./sealed-chat"
import type { A2AAgentCard, A2AJsonRpcRequest, A2AJsonRpcResponse, A2AMessage, A2ATask } from "./types"

/** The trimmed `did:key` a card serves, or undefined when the card is did-less. */
export function cardDid(card: A2AAgentCard): string | undefined {
  const did = card.did
  return typeof did === "string" && did.trim() ? did.trim() : undefined
}

export function endpointForCard(card: A2AAgentCard): string | undefined {
  const jsonRpc = card.supportedInterfaces?.find((entry) => (entry.protocolBinding ?? entry.transport)?.toUpperCase() === "JSONRPC")
  if (jsonRpc?.url) return jsonRpc.url
  if (card.preferredTransport?.toUpperCase() === "JSONRPC" && card.url) return card.url
  const legacyJsonRpc = card.additionalInterfaces?.find((entry) => entry.transport.toUpperCase() === "JSONRPC")
  return legacyJsonRpc?.url ?? card.url
}

export async function fetchA2AAgentCard(cardUrl: string, fetchImpl: typeof fetch = fetch): Promise<A2AAgentCard> {
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_card_fetch_start",
    message: "fetching A2A agent card",
    meta: { cardUrl },
  })
  const response = await fetchImpl(cardUrl)
  if (!response.ok) {
    throw new Error(`A2A card fetch failed (${response.status} ${response.statusText})`)
  }
  const parsed = await response.json() as A2AAgentCard
  const endpoint = endpointForCard(parsed)
  if (!parsed || typeof parsed !== "object" || typeof endpoint !== "string" || typeof parsed.name !== "string") {
    throw new Error("A2A card is missing required name or JSONRPC endpoint fields")
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_card_fetch_end",
    message: "fetched A2A agent card",
    meta: { cardUrl, endpoint, name: parsed.name },
  })
  return parsed
}

async function postJsonRpc(endpointUrl: string, request: A2AJsonRpcRequest, fetchImpl: typeof fetch, protocolVersion = "1.0"): Promise<A2AJsonRpcResponse> {
  const response = await fetchImpl(endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "A2A-Version": protocolVersion },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    throw new Error(`A2A JSON-RPC request failed (${response.status} ${response.statusText})`)
  }
  return await response.json() as A2AJsonRpcResponse
}

function methodNotFound(response: A2AJsonRpcResponse): boolean {
  return "error" in response && response.error.code === -32601
}

function senderMetadata(input: {
  senderAgentId?: string
  senderName?: string
  senderCardUrl?: string
}): Record<string, string> {
  return {
    ...(input.senderAgentId ? { senderAgentId: input.senderAgentId } : {}),
    ...(input.senderName ? { senderName: input.senderName } : {}),
    ...(input.senderCardUrl ? { senderCardUrl: input.senderCardUrl } : {}),
  }
}

export async function sendA2AMessage(input: {
  endpointUrl: string
  message: string
  taskId?: string
  accessToken?: string
  senderAgentId?: string
  senderName?: string
  senderCardUrl?: string
  sessionKey?: string
  fetchImpl?: typeof fetch
}): Promise<A2ATask> {
  const fetchImpl = input.fetchImpl ?? fetch
  const messageId = randomUUID()
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        contextId: input.sessionKey ?? "default",
        parts: [{ kind: "text", text: input.message }],
        metadata: senderMetadata(input),
      },
      ...(input.accessToken ? { accessToken: input.accessToken } : {}),
    },
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_message_send_start",
    message: "sending A2A message",
    meta: { endpointUrl: input.endpointUrl, messageId },
  })

  let rpc = await postJsonRpc(input.endpointUrl, request, fetchImpl, "0.3")
  if (methodNotFound(rpc)) {
    rpc = await postJsonRpc(input.endpointUrl, {
      ...request,
      method: "SendMessage",
      params: {
        ...(request.params as Record<string, unknown>),
        message: {
          ...((request.params as { message: Record<string, unknown> }).message),
          role: "ROLE_USER",
        },
      },
    }, fetchImpl)
  }
  if ("error" in rpc) {
    throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`)
  }
  const result = rpc.result as A2ATask | { task?: A2ATask }
  const task = "task" in result && result.task ? result.task : result as A2ATask
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_message_send_end",
    message: "sent A2A message",
    meta: { endpointUrl: input.endpointUrl, messageId, taskId: task.id },
  })
  return task
}

/**
 * POST a pre-built friends A2A message (a `wrapInDataPart` sealed-envelope message)
 * to a peer endpoint as a JSON-RPC `message/send`. This is the `direct`-rung wire
 * the harness `A2ATransport` uses: friends' `sendShare` builds the sealed message and
 * hands it to the transport, which delivers it here. Unlike `sendA2AMessage` (which
 * builds a text part), this carries the caller's exact `message` (the sealed DataPart)
 * untouched. Throws on a non-2xx response (transport failure).
 */
export async function postA2AMessageEnvelope(input: {
  endpointUrl: string
  message: { messageId?: string; role?: string; parts: unknown[] }
  fetchImpl?: typeof fetch
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/send",
    params: { message: input.message },
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_envelope_post_start",
    message: "posting sealed A2A message envelope (direct rung)",
    meta: { endpointUrl: input.endpointUrl },
  })
  let rpc = await postJsonRpc(input.endpointUrl, request, fetchImpl, "0.3")
  if (methodNotFound(rpc)) {
    rpc = await postJsonRpc(input.endpointUrl, { ...request, method: "SendMessage" }, fetchImpl)
  }
  if ("error" in rpc) {
    throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`)
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_envelope_post_end",
    message: "posted sealed A2A message envelope",
    meta: { endpointUrl: input.endpointUrl },
  })
}

export async function getA2ATask(input: {
  endpointUrl: string
  taskId: string
  accessToken?: string
  senderAgentId?: string
  senderName?: string
  senderCardUrl?: string
  fetchImpl?: typeof fetch
}): Promise<A2ATask> {
  const fetchImpl = input.fetchImpl ?? fetch
  const metadata = senderMetadata(input)
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tasks/get",
    params: {
      id: input.taskId,
      ...(input.accessToken ? { accessToken: input.accessToken } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_task_get",
    message: "fetching A2A task",
    meta: { endpointUrl: input.endpointUrl, taskId: input.taskId },
  })
  let rpc = await postJsonRpc(input.endpointUrl, request, fetchImpl, "0.3")
  if (methodNotFound(rpc)) {
    rpc = await postJsonRpc(input.endpointUrl, { ...request, method: "GetTask" }, fetchImpl)
  }
  if ("error" in rpc) {
    throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`)
  }
  return rpc.result as A2ATask
}

export interface SealedA2AChatReply {
  text: string
  /** The conversation id to pass back to continue this conversation. */
  conversationId: string
  taskId: string
  peerDid: string
  peerName: string
}

/**
 * Talk to an A2A agent as a verified friend: seal `text` to the agent's card DID,
 * signed by `identity`, send it, and open the sealed reply. The card must serve a
 * did:key bound to it (the same check onboarding applies), so the reply can only be
 * accepted from that key. Neither direction ever travels in plaintext.
 */
export async function sendSealedA2AChat(input: {
  cardUrl: string
  text: string
  conversationId?: string
  identity: DidKeyIdentity
  sodium?: Sodium
  fetchImpl?: typeof fetch
}): Promise<SealedA2AChatReply> {
  const fetchImpl = input.fetchImpl ?? fetch
  const sodium = input.sodium ?? await ready()
  const card = await fetchA2AAgentCard(input.cardUrl, fetchImpl)
  const peerDid = cardDid(card)
  if (!peerDid) throw new Error(`A2A card ${input.cardUrl} serves no DID; sealed chat needs one`)
  const parsed = parseDidKey(peerDid)
  if (!parsed || !verifyCardDidBinding({ card: { did: peerDid, url: input.cardUrl }, did: peerDid, didDoc: null })) {
    throw new Error(`A2A card↔DID binding failed for ${peerDid}`)
  }
  const endpointUrl = endpointForCard(card)!
  const conversationId = input.conversationId ?? randomUUID()
  const sealed = sealChatMessage({
    sodium,
    from: input.identity,
    recipientDid: peerDid,
    recipientEd25519Pub: parsed.ed25519Pub,
    text: input.text,
    conversationId,
  })
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "SendMessage",
    params: { message: { kind: "message", role: "ROLE_USER", messageId: randomUUID(), contextId: conversationId, parts: sealed.parts } },
  }
  emitNervesEvent({ component: "channels", event: "channel.a2a_chat_send_start", message: "sending sealed A2A chat message", meta: { endpointUrl, peerDid } })
  const rpc = await postJsonRpc(endpointUrl, request, fetchImpl)
  if ("error" in rpc) throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`)
  const task = rpc.result as A2ATask
  const replyMessage = task?.status?.message as A2AMessage | undefined
  if (!replyMessage) throw new Error("A2A chat returned no reply message")
  const opened = await openChatMessage({ sodium, self: input.identity, message: replyMessage, senderDid: peerDid, senderEd25519Pub: parsed.ed25519Pub })
  if (!opened.ok) throw new Error(`A2A chat reply rejected: ${opened.reason}`)
  emitNervesEvent({ component: "channels", event: "channel.a2a_chat_send_end", message: "received sealed A2A chat reply", meta: { endpointUrl, peerDid, taskId: task.id } })
  return { text: opened.text, conversationId, taskId: task.id, peerDid, peerName: card.name }
}
