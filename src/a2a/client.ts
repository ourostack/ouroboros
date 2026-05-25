import { randomUUID } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import type { A2AAgentCard, A2AJsonRpcRequest, A2AJsonRpcResponse, A2ATask } from "./types"

export function endpointForCard(card: A2AAgentCard): string | undefined {
  const jsonRpc = card.supportedInterfaces?.find((entry) => entry.protocolBinding.toUpperCase() === "JSONRPC")
  return jsonRpc?.url ?? card.url
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
    throw new Error("A2A card is missing required name/supportedInterfaces fields")
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_card_fetch_end",
    message: "fetched A2A agent card",
    meta: { cardUrl, endpoint, name: parsed.name },
  })
  return parsed
}

async function postJsonRpc(endpointUrl: string, request: A2AJsonRpcRequest, fetchImpl: typeof fetch): Promise<A2AJsonRpcResponse> {
  const response = await fetchImpl(endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    throw new Error(`A2A JSON-RPC request failed (${response.status} ${response.statusText})`)
  }
  return await response.json() as A2AJsonRpcResponse
}

export async function sendA2AMessage(input: {
  endpointUrl: string
  message: string
  peerAgentId?: string
  peerName?: string
  sessionKey?: string
  fetchImpl?: typeof fetch
}): Promise<A2ATask> {
  const fetchImpl = input.fetchImpl ?? fetch
  const messageId = randomUUID()
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "SendMessage",
    params: {
      message: {
        role: "ROLE_USER",
        messageId,
        contextId: input.sessionKey ?? "default",
        parts: [{ text: input.message }],
        metadata: {
          ...(input.peerAgentId ? { agentId: input.peerAgentId } : {}),
          ...(input.peerName ? { agentName: input.peerName } : {}),
        },
      },
    },
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_message_send_start",
    message: "sending A2A message",
    meta: { endpointUrl: input.endpointUrl, messageId },
  })

  const rpc = await postJsonRpc(input.endpointUrl, request, fetchImpl)
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

export async function getA2ATask(input: {
  endpointUrl: string
  taskId: string
  fetchImpl?: typeof fetch
}): Promise<A2ATask> {
  const fetchImpl = input.fetchImpl ?? fetch
  const request: A2AJsonRpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "GetTask",
    params: { id: input.taskId },
  }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_task_get",
    message: "fetching A2A task",
    meta: { endpointUrl: input.endpointUrl, taskId: input.taskId },
  })
  const rpc = await postJsonRpc(input.endpointUrl, request, fetchImpl)
  if ("error" in rpc) {
    throw new Error(`A2A error ${rpc.error.code}: ${rpc.error.message}`)
  }
  return rpc.result as A2ATask
}
