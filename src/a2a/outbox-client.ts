import { randomUUID } from "node:crypto"
import { parseDidKey, ready, verifyCardDidBinding, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { cardDid, endpointForCard, fetchA2AAgentCard, postJsonRpc } from "./client"
import { encodeOutboxCommand, type OutboxMethod } from "./outbox-wire"
import { openChatMessage, sealChatMessage } from "./sealed-chat"
import type { A2AJsonRpcRequest, A2AMessage } from "./types"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Calls one outbox method on an A2A agent as a verified friend. The request is sealed to the agent's card DID and
 * signed by `identity`, and the reply is opened only if it was sealed by that same card key, so neither direction
 * travels in plaintext. Throws with the agent's refusal text when the agent answers with a JSON-RPC error.
 */
export async function callOutboxMethod(input: {
  cardUrl: string
  method: OutboxMethod
  params: Record<string, unknown>
  identity: DidKeyIdentity
  sodium?: Sodium
  fetchImpl?: typeof fetch
}): Promise<Record<string, unknown>> {
  const fetchImpl = input.fetchImpl ?? fetch
  const sodium = input.sodium ?? await ready()
  const card = await fetchA2AAgentCard(input.cardUrl, fetchImpl)
  const peerDid = cardDid(card)
  if (!peerDid) throw new Error(`A2A card ${input.cardUrl} serves no DID; outbox calls need one`)
  const parsed = parseDidKey(peerDid)
  if (!parsed || !verifyCardDidBinding({ card: { did: peerDid, url: input.cardUrl }, did: peerDid, didDoc: null })) {
    throw new Error(`A2A card↔DID binding failed for ${peerDid}`)
  }
  const endpointUrl = endpointForCard(card)!
  const conversationId = randomUUID()
  const sealed = sealChatMessage({
    sodium, from: input.identity, recipientDid: peerDid, recipientEd25519Pub: parsed.ed25519Pub,
    text: encodeOutboxCommand(input.method, input.params), conversationId,
  })
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0", id: randomUUID(), method: input.method,
    params: { message: { kind: "message", role: "ROLE_USER", messageId: randomUUID(), contextId: conversationId, parts: sealed.parts } },
  }
  emitNervesEvent({ component: "channels", event: "channel.a2a_outbox_call_start", message: "calling an A2A outbox method", meta: { endpointUrl, peerDid, method: input.method } })
  const rpc = await postJsonRpc(endpointUrl, request, fetchImpl)
  if ("error" in rpc) throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`)
  const reply = rpc.result as A2AMessage | undefined
  if (!reply || !Array.isArray(reply.parts)) throw new Error("A2A outbox call returned no reply message")
  const opened = await openChatMessage({ sodium, self: input.identity, message: reply, senderDid: peerDid, senderEd25519Pub: parsed.ed25519Pub })
  if (!opened.ok) throw new Error(`A2A outbox reply rejected: ${opened.reason}`)
  let result: unknown
  try {
    result = JSON.parse(opened.text)
  } catch {
    throw new Error("A2A outbox reply was not JSON")
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("A2A outbox reply was not a JSON object")
  emitNervesEvent({ component: "channels", event: "channel.a2a_outbox_call_end", message: "received an A2A outbox reply", meta: { endpointUrl, peerDid, method: input.method } })
  return result as Record<string, unknown>
}
