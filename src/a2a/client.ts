import { randomUUID } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import type { A2AAgentCard, A2AJsonRpcRequest, A2AJsonRpcResponse, A2ATask } from "./types"

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
