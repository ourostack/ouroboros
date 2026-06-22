import * as http from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { ready } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore } from "@ouro.bot/friends"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { runSenseTurn } from "../senses/shared-turn"
import { buildA2AAgentCard } from "./card"
import { A2A_DEFAULT_HOST, defaultA2APort, normalizeA2APath } from "./config"
import type { A2AIdentity } from "./identity"
import { FileA2APinStore } from "./pin-store"
import { FileA2ASeenLedger } from "./seen-ledger"
import { makeDidResolution } from "./did-resolution"
import { receiveInboundShare, type InboundShareDeps } from "./inbound-share"
import { isMissionResultDataPart, receiveInboundMissionResult } from "./mission-result-wire"
import { delegationStoresFor } from "./delegation-stores"
import { FileA2ATaskStore } from "./task-store"
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2AMessage, A2ATask } from "./types"

const MAX_A2A_REQUEST_BYTES = 128 * 1024
const MAX_A2A_MESSAGE_TEXT_CHARS = 16_000

type A2AResponseStyle = "latest" | "legacy"

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
  /** The agent's self A2A cryptographic identity (did:key over an Ed25519 seed).
   * When present, the served agent card carries `card.did` and the inbound bridge
   * can unseal friends DataParts addressed to this DID. Absent in legacy/no-identity
   * deployments (the card omits `did`; inbound stays on the text-only path). */
  identity?: A2AIdentity
}

export interface A2AServerHandle {
  server: http.Server
  url: string
  endpointUrl: string
  close(): Promise<void>
}

class A2ARequestError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message)
  }
}

function jsonResponse(id: A2AJsonRpcRequest["id"], result: unknown): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result }
}

function errorResponse(id: A2AJsonRpcRequest["id"], code: number, message: string): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    /* v8 ignore next -- Node HTTP request bodies arrive as Buffers in this runtime; string chunks are defensive stream compatibility @preserve */
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_A2A_REQUEST_BYTES) {
      throw new A2ARequestError(413, -32000, `A2A request body exceeds ${MAX_A2A_REQUEST_BYTES} bytes`)
    }
    chunks.push(buffer)
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

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  /* v8 ignore next -- protocol callers pass JSON-RPC param/message objects; this guard keeps malformed direct input inert @preserve */
  if (!value || typeof value !== "object") return undefined
  /* v8 ignore next -- JSON-RPC params/messages are objects in supported calls; array guard protects malformed direct input @preserve */
  if (Array.isArray(value)) return undefined
  const metadata = (value as { metadata?: unknown }).metadata
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : undefined
}

function metadataStringFromRecord(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function metadataString(message: A2AMessage | null, key: string): string | undefined {
  return metadataStringFromRecord(metadataRecord(message), key)
}

function headerString(req: http.IncomingMessage, key: string): string | undefined {
  const value = req.headers[key]
  /* v8 ignore next -- Node lower-cases singular request headers here; array values are defensive compatibility @preserve */
  if (Array.isArray(value)) return value[0]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/* v8 ignore start -- default runner crosses into the full live agent pipeline; shared-turn covers that pipeline and server tests inject a deterministic runner @preserve */
function storageKeyFor(peerExternalId: string): string {
  return `a2a-${createHash("sha256").update(peerExternalId).digest("hex").slice(0, 24)}`
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
/* v8 ignore stop */

function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex")
}

function accessTokenScope(accessToken: string): string {
  return `a2a-task-token:${accessTokenHash(accessToken)}`
}

function untrustedTurnPeerExternalId(): string {
  return "unauthenticated-a2a-peer"
}

/** Whether an inbound message carries a friends sealed DataPart (`kind:"data"`). */
function messageHasDataPart(message: A2AMessage): boolean {
  /* v8 ignore next -- defensive: callers pass a parsed inbound whose `parts` is always an array; guards malformed direct input @preserve */
  if (!Array.isArray(message.parts)) return false
  return message.parts.some((part) => part && part.kind === "data")
}

/** Map a friends `receiveShare` rejection reason → a JSON-RPC error code.
 * Malformed-shape reasons map to invalid-params (-32602); auth/trust/replay
 * rejections map to a dedicated A2A "rejected" code (-32003). */
function rejectionErrorCode(reason: string): number {
  if (reason === "malformed_message" || reason === "malformed_plaintext") return -32602
  return -32003
}

function senderHintFromMessage(req: http.IncomingMessage, inbound: A2AMessage): { idHint?: string; name: string } {
  const idHint = metadataString(inbound, "senderAgentId")
    ?? metadataString(inbound, "senderCardUrl")
    ?? metadataString(inbound, "agentId")
    ?? metadataString(inbound, "cardUrl")
    ?? headerString(req, "x-a2a-agent-id")
  const name = metadataString(inbound, "senderName")
    ?? metadataString(inbound, "agentName")
    ?? headerString(req, "x-a2a-agent-name")
    ?? idHint
    ?? "Unauthenticated A2A peer"
  return { idHint, name }
}

function isTerminalTaskState(state: A2ATask["status"]["state"]): boolean {
  return state === "TASK_STATE_COMPLETED"
    || state === "TASK_STATE_FAILED"
    || state === "TASK_STATE_CANCELED"
    || state === "TASK_STATE_REJECTED"
    || state === "completed"
    || state === "failed"
    || state === "canceled"
    || state === "rejected"
}

function accessTokenFromParams(params: unknown): string | undefined {
  /* v8 ignore next -- GetTask/CancelTask validate object params before token extraction; this keeps direct helper use defensive @preserve */
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined
  const record = params as Record<string, unknown>
  const direct = record.accessToken ?? record.access_token
  if (typeof direct === "string" && direct.trim()) return direct.trim()
  return metadataStringFromRecord(metadataRecord(params), "accessToken")
}

function taskA2AMetadata(task: A2ATask): Record<string, unknown> {
  const a2a = task.metadata?.a2a
  /* v8 ignore next -- server-created tasks always carry object auth metadata; fallback protects legacy/corrupt task files @preserve */
  if (!a2a || typeof a2a !== "object" || Array.isArray(a2a)) return {}
  return a2a as Record<string, unknown>
}

function publicMessage(message: A2AMessage, style: A2AResponseStyle): A2AMessage {
  const parts = message.parts
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => style === "legacy" ? { ...part, kind: part.kind ?? "text" } : part)
  if (style === "latest") return { ...message, kind: "message", parts }
  return {
    ...message,
    kind: "message",
    role: message.role === "ROLE_AGENT" ? "agent" : message.role === "ROLE_USER" ? "user" : message.role,
    parts,
  }
}

function legacyTaskState(state: A2ATask["status"]["state"]): A2ATask["status"]["state"] {
  if (state === "TASK_STATE_SUBMITTED") return "submitted"
  if (state === "TASK_STATE_WORKING") return "working"
  if (state === "TASK_STATE_COMPLETED") return "completed"
  if (state === "TASK_STATE_FAILED") return "failed"
  if (state === "TASK_STATE_CANCELED") return "canceled"
  if (state === "TASK_STATE_REJECTED") return "rejected"
  if (state === "TASK_STATE_AUTH_REQUIRED") return "auth-required"
  if (state === "TASK_STATE_INPUT_REQUIRED") return "input-required"
  return state
}

function publicTask(task: A2ATask, accessToken: string, style: A2AResponseStyle, includeAccessToken: boolean): A2ATask {
  const a2a = taskA2AMetadata(task)
  const { accessTokenHash: _accessTokenHash, taskScopeHash: _taskScopeHash, ...safeA2A } = a2a
  const statusMessage = task.status.message ? publicMessage(task.status.message, style) : undefined
  return {
    ...task,
    kind: task.kind ?? "task",
    status: {
      ...task.status,
      state: style === "legacy" ? legacyTaskState(task.status.state) : task.status.state,
      ...(statusMessage ? { message: statusMessage } : {}),
    },
    history: task.history.map((message) => publicMessage(message, style)),
    ...(task.artifacts ? {
      artifacts: task.artifacts.map((artifact) => ({
        ...artifact,
        parts: style === "legacy"
          ? artifact.parts.map((part) => ({ ...part, kind: part.kind ?? "text" }))
          : artifact.parts,
      })),
    } : {}),
    metadata: {
      ...task.metadata,
      a2a: {
        ...safeA2A,
        ...(includeAccessToken ? { accessToken } : {}),
      },
    },
  }
}

function taskAuthorized(task: A2ATask, accessToken: string): boolean {
  const a2a = taskA2AMetadata(task)
  return a2a.accessTokenHash === accessTokenHash(accessToken)
}

function taskFor(input: {
  taskId: string
  accessToken: string
  contextId: string
  inbound: A2AMessage
  state: A2ATask["status"]["state"]
  response?: string
  clientTaskId?: string
  previousTask?: A2ATask
}): A2ATask {
  const now = new Date().toISOString()
  const history = [...(input.previousTask?.history ?? []), input.inbound]
  const previousA2A = input.previousTask ? taskA2AMetadata(input.previousTask) : {}
  const responseMessage: A2AMessage | undefined = input.response
      ? {
        kind: "message",
        role: "ROLE_AGENT",
        taskId: input.taskId,
        contextId: input.contextId,
        messageId: randomUUID(),
        parts: [{ text: input.response }],
      }
    : undefined
  if (responseMessage) history.push(responseMessage)
  return {
    kind: "task",
    id: input.taskId,
    contextId: input.contextId,
    status: {
      state: input.state,
      timestamp: now,
      ...(responseMessage ? { message: responseMessage } : {}),
    },
    history,
    metadata: {
      ...input.previousTask?.metadata,
      a2a: {
        ...previousA2A,
        accessTokenHash: accessTokenHash(input.accessToken),
        ...(input.clientTaskId ? { clientTaskId: input.clientTaskId } : {}),
      },
    },
    ...(responseMessage ? {
      artifacts: [{
        artifactId: `artifact-${input.taskId}`,
        name: "response",
        parts: responseMessage.parts,
      }],
    } : {}),
  }
}

export async function startA2AServer(options: StartA2AServerOptions): Promise<A2AServerHandle> {
  const host = options.host ?? A2A_DEFAULT_HOST
  /* v8 ignore next -- daemon-managed A2A owns the default-port path; protocol tests bind port 0 to avoid collisions @preserve */
  const port = options.port ?? defaultA2APort(options.agentName)
  const a2aPath = normalizeA2APath(options.path)
  /* v8 ignore next -- foreground CLI/default daemon paths own the ambient agent-root fallback; protocol tests inject an isolated root @preserve */
  const agentRoot = options.agentRoot ?? getAgentRoot(options.agentName)
  const taskStore = new FileA2ATaskStore(agentRoot)
  /* v8 ignore next -- default runner crosses into the full live agent pipeline; shared-turn covers that pipeline and server tests inject a deterministic runner @preserve */
  const turnRunner = options.turnRunner ?? defaultTurnRunner

  // The inbound friends-DataPart bridge is available only when the agent has a
  // cryptographic identity (its did:key + X25519 unseal keys). Build its durable
  // stores once at start; without an identity, inbound stays on the text path.
  let inboundShareDeps: InboundShareDeps | undefined
  if (options.identity) {
    const friendsDir = `${agentRoot}/friends`
    inboundShareDeps = {
      sodium: await ready(),
      store: new FileFriendStore(friendsDir),
      // The SAME canonical mission store the Slice-4 delegation tools use, so an
      // inbound `importCoordination` write lands where the read/prepare surface reads.
      missionStore: delegationStoresFor(agentRoot).missionStore,
      pinStore: new FileA2APinStore(agentRoot),
      seen: new FileA2ASeenLedger(agentRoot),
      didResolution: makeDidResolution({ sodium: await ready() }),
      identity: options.identity,
    }
  }

  let publicBaseUrl = options.baseUrl
  const server = http.createServer(async (req, res) => {
    /* v8 ignore next -- Node always supplies url/host for accepted HTTP requests; fallback keeps malformed local calls safe @preserve */
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`)
    /* v8 ignore next -- host fallback is defensive for malformed local requests; publicBaseUrl/default host branches are covered @preserve */
    const currentBaseUrl = publicBaseUrl ?? `http://${req.headers.host ?? `${host}:${port}`}`

    if (req.method === "GET" && (requestUrl.pathname === "/.well-known/agent-card.json" || requestUrl.pathname === "/agent-card.json")) {
      writeJson(res, 200, buildA2AAgentCard({
        agentName: options.agentName,
        baseUrl: currentBaseUrl,
        path: a2aPath,
        ...(options.identity ? { did: options.identity.did } : {}),
      }))
      return
    }

    if (req.method !== "POST" || requestUrl.pathname !== a2aPath) {
      writeJson(res, 404, { error: "not found" })
      return
    }

    let rpc: A2AJsonRpcRequest
    try {
      const rawBody = await readBody(req)
      rpc = JSON.parse(rawBody) as A2AJsonRpcRequest
    } catch (error) {
      if (error instanceof A2ARequestError) {
        writeJson(res, error.status, errorResponse(null, error.code, error.message))
        return
      }
      writeJson(res, 400, errorResponse(null, -32700, "invalid JSON"))
      return
    }

    try {
      if (rpc.method === "SendMessage" || rpc.method === "message/send") {
        const responseStyle: A2AResponseStyle = rpc.method === "message/send" ? "legacy" : "latest"
        const parsedInbound = messageFromParams(rpc.params)
        const inbound = parsedInbound ? { ...parsedInbound, kind: parsedInbound.kind ?? "message" } : null

        // HARNESS-OWNED RESULT WIRE (runs BEFORE the friends-share branch). A
        // `mission_result`-tagged DataPart is NOT a FriendsKind — it routes to
        // `importMissionResult` (assignee/correlation-gated, store-only, NO turn), never
        // to `receiveShare`. Recognized by the `ouroKind` discriminator.
        if (inbound && inboundShareDeps && isMissionResultDataPart(inbound)) {
          const imported = await receiveInboundMissionResult(inbound, {
            sodium: inboundShareDeps.sodium,
            store: inboundShareDeps.store,
            missionStore: inboundShareDeps.missionStore,
            // The SAME authentication seam the share bridge uses — so a forged-sender
            // result is rejected by the DidVerifier exactly like a forged share.
            pinStore: inboundShareDeps.pinStore,
            seen: inboundShareDeps.seen,
            didResolution: inboundShareDeps.didResolution,
            identity: inboundShareDeps.identity,
          })
          if (imported.outcome === "rejected") {
            writeJson(res, 200, errorResponse(rpc.id, rejectionErrorCode(imported.reason), `A2A result rejected: ${imported.reason}`))
            return
          }
          // imported (store-only, no turn): acknowledge with a minimal completed task.
          /* v8 ignore next -- "not-a-result" is unreachable here (gated by isMissionResultDataPart) @preserve */
          const ackText = imported.outcome === "imported"
            ? `[a2a] imported mission result from ${imported.verifiedDid}`
            /* v8 ignore next -- defensive: the gate above guarantees imported|rejected @preserve */
            : "[a2a] mission result"
          const contextId = inbound.contextId ?? "default"
          const taskId = randomUUID()
          const accessToken = randomUUID()
          const ackTask = taskFor({ taskId, accessToken, contextId, inbound, state: "TASK_STATE_COMPLETED", response: ackText })
          taskStore.put(ackTask, accessTokenScope(accessToken))
          writeJson(res, 200, jsonResponse(rpc.id, publicTask(ackTask, accessToken, responseStyle, true)))
          return
        }

        // Inbound friends-DataPart branch (runs BEFORE the legacy text path). A
        // sealed DataPart is unwrapped + verified through the bridge; the turn is
        // then keyed on the VERIFIED sender DID (replacing the unauthenticated
        // sentinel). A non-friends (text) message falls through unchanged.
        let verifiedPeerAgentId: string | undefined
        let verifiedPeerName: string | undefined
        let verifiedShareText: string | undefined
        if (inbound && inboundShareDeps && messageHasDataPart(inbound)) {
          const bridged = await receiveInboundShare(inbound, inboundShareDeps)
          if (bridged.outcome === "rejected") {
            writeJson(res, 200, errorResponse(rpc.id, rejectionErrorCode(bridged.reason), `A2A share rejected: ${bridged.reason}`))
            return
          }
          // A message with a data part always resolves to completed|rejected — the
          // bridge only returns "not-a-share" when there is NO data part, which the
          // `messageHasDataPart` gate above excludes. So this is the completed path.
          /* v8 ignore next -- "not-a-share" is unreachable here (gated by messageHasDataPart) @preserve */
          if (bridged.outcome === "completed") {
            verifiedPeerAgentId = bridged.verifiedDid
            verifiedPeerName = bridged.verifiedDid
            verifiedShareText = `[a2a] received ${bridged.friendsKind} (${bridged.status}) from ${bridged.verifiedDid}`
          }
        }

        const text = verifiedShareText ?? textFromMessage(inbound)
        if (!inbound || !text) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "SendMessage requires a text message"))
          return
        }
        if (text.length > MAX_A2A_MESSAGE_TEXT_CHARS) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, `SendMessage text exceeds ${MAX_A2A_MESSAGE_TEXT_CHARS} characters`))
          return
        }
        const senderHint = senderHintFromMessage(req, inbound)
        // The verified DID wins as the turn's peer identity; otherwise the legacy
        // unauthenticated sentinel (text path, behavior-preserved).
        const peerAgentId = verifiedPeerAgentId ?? untrustedTurnPeerExternalId()
        const peerName = verifiedPeerName ?? senderHint.name
        const continuationToken = accessTokenFromParams(rpc.params)
        const continuationTask = inbound.taskId && continuationToken
          ? taskStore.get(inbound.taskId, accessTokenScope(continuationToken))
          : null
        if (inbound.taskId && continuationToken && (!continuationTask || !taskAuthorized(continuationTask, continuationToken))) {
          writeJson(res, 200, errorResponse(rpc.id, -32001, "task not found"))
          return
        }
        if (continuationTask && isTerminalTaskState(continuationTask.status.state)) {
          writeJson(res, 200, errorResponse(rpc.id, -32002, "task is terminal; start a new task"))
          return
        }
        const contextId = inbound.contextId ?? continuationTask?.contextId ?? "default"
        const taskId = continuationTask?.id ?? randomUUID()
        const accessToken = continuationToken && continuationTask ? continuationToken : randomUUID()
        const tokenScope = accessTokenScope(accessToken)
        const clientTaskId = continuationTask ? taskA2AMetadata(continuationTask).clientTaskId as string | undefined : inbound.taskId
        taskStore.put(taskFor({ taskId, accessToken, contextId, inbound, state: "TASK_STATE_WORKING", clientTaskId, previousTask: continuationTask ?? undefined }), tokenScope)
        const turn = await turnRunner({
          agentName: options.agentName,
          peerAgentId,
          peerName,
          sessionKey: contextId,
          message: text,
        })
        const task = taskFor({ taskId, accessToken, contextId, inbound, state: "TASK_STATE_COMPLETED", response: turn.response, clientTaskId, previousTask: continuationTask ?? undefined })
        taskStore.put(task, tokenScope)
        writeJson(res, 200, jsonResponse(rpc.id, publicTask(task, accessToken, responseStyle, true)))
        return
      }

      if (rpc.method === "GetTask" || rpc.method === "tasks/get") {
        const responseStyle: A2AResponseStyle = rpc.method === "tasks/get" ? "legacy" : "latest"
        const taskId = rpc.params && typeof rpc.params === "object"
          ? (rpc.params as { id?: unknown }).id
          : undefined
        if (typeof taskId !== "string" || !taskId.trim()) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "GetTask requires id"))
          return
        }
        const accessToken = accessTokenFromParams(rpc.params)
        if (!accessToken) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "GetTask requires accessToken"))
          return
        }
        const task = taskStore.get(taskId, accessTokenScope(accessToken))
        writeJson(res, 200, task && taskAuthorized(task, accessToken)
          ? jsonResponse(rpc.id, publicTask(task, accessToken, responseStyle, false))
          : errorResponse(rpc.id, -32001, "task not found"))
        return
      }

      if (rpc.method === "CancelTask" || rpc.method === "tasks/cancel") {
        const responseStyle: A2AResponseStyle = rpc.method === "tasks/cancel" ? "legacy" : "latest"
        const taskId = rpc.params && typeof rpc.params === "object"
          ? (rpc.params as { id?: unknown }).id
          : undefined
        if (typeof taskId !== "string" || !taskId.trim()) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "CancelTask requires id"))
          return
        }
        const accessToken = accessTokenFromParams(rpc.params)
        if (!accessToken) {
          writeJson(res, 200, errorResponse(rpc.id, -32602, "CancelTask requires accessToken"))
          return
        }
        const tokenScope = accessTokenScope(accessToken)
        const task = taskStore.get(taskId, tokenScope)
        if (!task || !taskAuthorized(task, accessToken)) {
          writeJson(res, 200, errorResponse(rpc.id, -32001, "task not found"))
          return
        }
        const canceled: A2ATask = {
          ...task,
          status: { state: "TASK_STATE_CANCELED", timestamp: new Date().toISOString() },
        }
        taskStore.put(canceled, tokenScope)
        writeJson(res, 200, jsonResponse(rpc.id, publicTask(canceled, accessToken, responseStyle, false)))
        return
      }

      writeJson(res, 200, errorResponse(rpc.id, -32601, `unknown method: ${rpc.method}`))
    } catch (error) {
      const message = error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error)
      writeJson(res, 200, errorResponse(rpc.id, -32000, message))
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
  const address = server.address()
  /* v8 ignore next -- server.address() is an address object after successful listen on TCP @preserve */
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
