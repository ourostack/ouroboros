import * as http from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { runSenseTurn } from "../senses/shared-turn"
import { buildA2AAgentCard } from "./card"
import { A2A_DEFAULT_HOST, defaultA2APort, normalizeA2APath } from "./config"
import { FileA2ATaskStore } from "./task-store"
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2AMessage, A2ATask } from "./types"

export interface A2ATurnRunnerInput {
  agentName: string
  peerAgentId: string
  peerName: string
  sessionKey: string
  message: string
}

export interface A2ATurnRunnerOutput {
  response: string
}

export type A2ATurnRunner = (input: A2ATurnRunnerInput) => Promise<A2ATurnRunnerOutput>

export interface StartA2AServerOptions {
  agentName: string
  host?: string
  port?: number
  baseUrl?: string
  path?: string
  agentRoot?: string
  turnRunner?: A2ATurnRunner
}

export interface A2AServerHandle {
  server: http.Server
  url: string
  endpointUrl: string
  close(): Promise<void>
}

function jsonResponse(id: A2AJsonRpcRequest["id"], result: unknown): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result }
}

function errorResponse(id: A2AJsonRpcRequest["id"], code: number, message: string): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const text = (part as { text?: unknown }).text
      return typeof text === "string" ? text : ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function messageFromParams(params: unknown): A2AMessage | null {
  if (!params || typeof params !== "object") return null
  const message = (params as { message?: unknown }).message
  if (!message || typeof message !== "object") return null
  return message as A2AMessage
}

function metadataString(message: A2AMessage | null, key: string): string | undefined {
  const value = message?.metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function headerString(req: http.IncomingMessage, key: string): string | undefined {
  const value = req.headers[key]
  if (Array.isArray(value)) return value[0]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function storageKeyFor(peerAgentId: string): string {
  return `a2a-${createHash("sha256").update(peerAgentId).digest("hex").slice(0, 24)}`
}

async function defaultTurnRunner(input: A2ATurnRunnerInput): Promise<A2ATurnRunnerOutput> {
  const result = await runSenseTurn({
    agentName: input.agentName,
    channel: "a2a",
    friendId: storageKeyFor(input.peerAgentId),
    sessionKey: input.sessionKey,
    userMessage: input.message,
    latencyMode: "standard",
    identity: {
      provider: "a2a-agent",
      externalId: input.peerAgentId,
      displayName: input.peerName,
    },
  })
  return { response: result.response }
}

function taskFor(input: {
  taskId: string
  contextId: string
  inbound: A2AMessage
  state: A2ATask["status"]["state"]
  response?: string
  error?: string
}): A2ATask {
  const now = new Date().toISOString()
  const history = [input.inbound]
  const responseMessage: A2AMessage | undefined = input.response
      ? {
        role: "ROLE_AGENT",
        taskId: input.taskId,
        contextId: input.contextId,
        messageId: randomUUID(),
        parts: [{ text: input.response }],
      }
    : undefined
  if (responseMessage) history.push(responseMessage)
  return {
    id: input.taskId,
    contextId: input.contextId,
    status: {
      state: input.state,
      timestamp: now,
      ...(responseMessage ? { message: responseMessage } : {}),
    },
    history,
    ...(responseMessage ? {
      artifacts: [{
        artifactId: `artifact-${input.taskId}`,
        name: "response",
        parts: responseMessage.parts,
      }],
    } : {}),
    ...(input.error ? { metadata: { error: input.error } } : {}),
  }
}

export async function startA2AServer(options: StartA2AServerOptions): Promise<A2AServerHandle> {
  const host = options.host ?? A2A_DEFAULT_HOST
  const port = options.port ?? defaultA2APort(options.agentName)
  const a2aPath = normalizeA2APath(options.path)
  const taskStore = new FileA2ATaskStore(options.agentRoot ?? getAgentRoot(options.agentName))
  const turnRunner = options.turnRunner ?? defaultTurnRunner

  let publicBaseUrl = options.baseUrl
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`)
    const currentBaseUrl = publicBaseUrl ?? `http://${req.headers.host ?? `${host}:${port}`}`

    if (req.method === "GET" && (requestUrl.pathname === "/.well-known/agent-card.json" || requestUrl.pathname === "/agent-card.json")) {
      writeJson(res, 200, buildA2AAgentCard({ agentName: options.agentName, baseUrl: currentBaseUrl, path: a2aPath }))
      return
    }

    if (req.method !== "POST" || requestUrl.pathname !== a2aPath) {
      writeJson(res, 404, { error: "not found" })
      return
    }

    let rpc: A2AJsonRpcRequest
    try {
      rpc = JSON.parse(await readBody(req)) as A2AJsonRpcRequest
    } catch {
      writeJson(res, 400, errorResponse(null, -32700, "invalid JSON"))
      return
    }

    try {
      if (rpc.method === "SendMessage" || rpc.method === "message/send") {
        const inbound = messageFromParams(rpc.params)
        const text = textFromMessage(inbound)
        if (!inbound || !text) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "SendMessage requires a text message"))
          return
        }
        const peerAgentId = metadataString(inbound, "agentId")
          ?? metadataString(inbound, "cardUrl")
          ?? headerString(req, "x-a2a-agent-id")
          ?? "unknown-a2a-peer"
        const peerName = metadataString(inbound, "agentName")
          ?? headerString(req, "x-a2a-agent-name")
          ?? peerAgentId
        const contextId = inbound.contextId ?? "default"
        const taskId = inbound.taskId ?? randomUUID()
        taskStore.put(taskFor({ taskId, contextId, inbound, state: "TASK_STATE_WORKING" }))
        const turn = await turnRunner({
          agentName: options.agentName,
          peerAgentId,
          peerName,
          sessionKey: contextId,
          message: text,
        })
        const task = taskFor({ taskId, contextId, inbound, state: "TASK_STATE_COMPLETED", response: turn.response })
        taskStore.put(task)
        writeJson(res, 200, jsonResponse(rpc.id, { task }))
        return
      }

      if (rpc.method === "GetTask" || rpc.method === "tasks/get") {
        const taskId = rpc.params && typeof rpc.params === "object"
          ? (rpc.params as { id?: unknown }).id
          : undefined
        if (typeof taskId !== "string" || !taskId.trim()) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "GetTask requires id"))
          return
        }
        const task = taskStore.get(taskId)
        writeJson(res, 200, task ? jsonResponse(rpc.id, task) : errorResponse(rpc.id, -32001, "task not found"))
        return
      }

      if (rpc.method === "CancelTask" || rpc.method === "tasks/cancel") {
        const taskId = rpc.params && typeof rpc.params === "object"
          ? (rpc.params as { id?: unknown }).id
          : undefined
        if (typeof taskId !== "string" || !taskId.trim()) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "CancelTask requires id"))
          return
        }
        const task = taskStore.get(taskId)
        if (!task) {
          writeJson(res, 200, errorResponse(rpc.id, -32001, "task not found"))
          return
        }
        const canceled: A2ATask = {
          ...task,
          status: { state: "TASK_STATE_CANCELED", timestamp: new Date().toISOString() },
        }
        taskStore.put(canceled)
        writeJson(res, 200, jsonResponse(rpc.id, canceled))
        return
      }

      writeJson(res, 200, errorResponse(rpc.id, -32601, `unknown method: ${rpc.method}`))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 200, errorResponse(rpc.id, -32000, message))
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve())
  })
  const address = server.address()
  const actualPort = typeof address === "object" && address ? address.port : port
  const localBaseUrl = `http://${host}:${actualPort}`
  publicBaseUrl = publicBaseUrl ?? localBaseUrl
  const endpointUrl = new URL(publicBaseUrl)
  endpointUrl.pathname = a2aPath
  endpointUrl.search = ""
  endpointUrl.hash = ""

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_server_started",
    message: "A2A sense server started",
    meta: { agentName: options.agentName, url: publicBaseUrl, endpoint: endpointUrl.toString() },
  })

  return {
    server,
    url: publicBaseUrl,
    endpointUrl: endpointUrl.toString(),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_server_stopped",
          message: "A2A sense server stopped",
          meta: { agentName: options.agentName },
        })
        resolve()
      })
    }),
  }
}
