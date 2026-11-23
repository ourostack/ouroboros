import { approvalRelaySocketPath, forwardApprovalAnswer } from "./approval-relay-forward"
import * as http from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { ready } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore } from "@ouro.bot/friends"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { runSenseTurn } from "../senses/shared-turn"
import { MAX_INBOUND_ATTEMPTS, openInboundJournal, type PendingInbound } from "../senses/inbound-journal"
import { buildA2AAgentCard } from "./card"
import { A2A_DEFAULT_HOST, defaultA2APort, normalizeA2APath } from "./config"
import type { A2AIdentity } from "./identity"
import { FileA2APinStore } from "./pin-store"
import { FileA2ASeenLedger } from "./seen-ledger"
import { makeDidResolution } from "./did-resolution"
import { receiveInboundShare, type InboundShareDeps } from "./inbound-share"
import { createSanctuaryToolContext, isSanctuaryAgent } from "../senses/sanctuary-runtime"
import { sealChatMessage } from "./sealed-chat"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry, type RelationshipAuthorizationEvaluator } from "../repertoire/relationship-authorization"
import type { FriendRecord } from "@ouro.bot/friends"
import { isMissionResultDataPart, receiveInboundMissionResult } from "./mission-result-wire"
import { delegationStoresFor } from "./delegation-stores"
import { FileA2ATaskStore } from "./task-store"
import { admitDelegatedCommand, delegationRefusalGuidance, shieldDelegatedBanner, type A2ADelegationOptions, type DelegatedCommandContext } from "./delegated-command"
import { receiveRefusalError } from "./refusals"
import { startRelayInbox, type RelayConfigStore, type RelayInboxHandle, type RelayOwnerNotifier, type RelayTimers } from "./relay-inbox"
import { fileRelayRetirements } from "./relay-retirements"
import { handleOutboxCommand, isOutboxMethod, parseOutboxCommand, OUTBOX_ERROR_INVALID, OUTBOX_ERROR_REFUSED } from "./outbox-wire"
import { confirmResolvedReports, dispatchPendingFailureReports, type ConfirmDeps } from "../heart/failure-reports"
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2AMessage, A2ATask } from "./types"

const MAX_A2A_REQUEST_BYTES = 128 * 1024
const MAX_A2A_MESSAGE_TEXT_CHARS = 16_000

/** How long one A2A turn may run before it is stopped and recorded as failed: the iMessage turn deadline. */
export const A2A_TURN_TIMEOUT_MS = 10 * 60_000

type A2AResponseStyle = "latest" | "legacy"

export interface A2ATurnRunnerInput {
  agentName: string
  peerAgentId: string
  peerName: string
  sessionKey: string
  message: string
  /** For a verified friend's chat: the relationship that scopes this turn's tools. */
  relationshipAuthorization?: RelationshipAuthorizationEvaluator
  /** Present only when the server admitted a delegated principal command. */
  delegatedCommand?: DelegatedCommandContext
  /** Aborts when the sender cancels the task, the turn passes its deadline, or the sense shuts down. */
  signal?: AbortSignal
  /** Call when the turn gets its place in the turn queue: its deadline starts again from there. */
  onTurnStart?: () => void
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
  /** Tests: how a verified approval answer reaches the Telegram sense (default: its `relay.sock`). */
  forwardApprovalAnswer?: typeof forwardApprovalAnswer
  /** The agent's self A2A cryptographic identity (did:key over an Ed25519 seed).
   * When present, the served agent card carries `card.did` and the inbound bridge
   * can unseal friends DataParts addressed to this DID. Absent in legacy/no-identity
   * deployments (the card omits `did`; inbound stays on the text-only path). */
  identity?: A2AIdentity
  /** Enables delegated principal commands. Absent: every delegated marker is refused. */
  delegation?: A2ADelegationOptions
  /** Tells the owner about a problem only they can fix (a rotated peer whose friend record could not follow). Absent: nerves records it. */
  notifyOwner?: (notice: { noticeId: string; text: string }) => Promise<void>
  /** Enables telling the owner when a resolved failure report's fix is live. Absent: reports can be resolved but never confirmed. */
  escalation?: ConfirmDeps & { confirmIntervalMs?: number }
  /** This agent's friends-relay inbox (needs `identity`): peers queue sealed messages there while it is offline, and the
   * server polls it and runs each one as a `message/send`. Absent: no relay inbox. */
  relay?: { config: RelayConfigStore; fetchImpl?: typeof fetch; intervalMs?: number; timers?: RelayTimers; notifyOwner?: RelayOwnerNotifier }
  /** How long one turn may run before it is stopped and recorded as failed. Default `A2A_TURN_TIMEOUT_MS`. */
  turnTimeoutMs?: number
}

export const ESCALATION_CONFIRM_INTERVAL_MS = 5 * 60 * 1000

export interface A2AServerHandle {
  server: http.Server
  url: string
  endpointUrl: string
  /** The relay inbox poller, when `relay` was given with an identity. */
  relay?: RelayInboxHandle
  /** Settles once the inbounds an earlier process left pending have been replayed or recorded as failed. */
  replayed: Promise<void>
  /** Stops in-flight turns (a relayed message stays pending for the next process) and closes the server. */
  close(): Promise<void>
}

/** Where an inbound came from: a direct POST, whose sender waits on the HTTP reply, or the relay inbox, whose sender does not. */
type A2AInboundOrigin = "direct" | "relay"

/**
 * One inbound turn as plain data, written to the inbound journal before the turn runs, so the next process can replay
 * it (a relayed message) or record why it can't (a direct one, whose reply channel closed with the old process).
 */
interface A2AInboundRecord {
  origin: A2AInboundOrigin
  responseStyle: A2AResponseStyle
  taskId: string
  accessTokenHash: string
  contextId: string
  inbound: A2AMessage
  clientTaskId?: string
  previousTask?: A2ATask
  peerAgentId: string
  peerName: string
  /** The verified or plain text, before the server adds any banner. */
  text: string
  verifiedChat?: { did: string; friendId?: string; onBehalfOf?: "principal"; bindingId?: string; issuedAt?: string }
}

type A2ATurnStopReason = "canceled" | "shutdown" | "deadline"

class A2ATurnStopped extends Error {
  constructor(readonly reason: A2ATurnStopReason) {
    super(`A2A turn stopped: ${reason}`)
  }
}

/** The direct sender's view when the process stops mid-turn: the old HTTP reply is gone, so the message is not run again. */
const STOPPED_BEFORE_ANSWERING = "the agent stopped before answering this message; send it again"

/** What a message that arrives during shutdown hears. It is recorded, so the next process replays it or records why not. */
const AGENT_RESTARTING = "the agent is restarting and did not run this message yet"

class A2ARequestError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message)
  }
}

function jsonResponse(id: A2AJsonRpcRequest["id"], result: unknown): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result }
}

function errorResponse(id: A2AJsonRpcRequest["id"], code: number, message: string, data?: unknown): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }
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

function headerString(req: http.IncomingMessage | undefined, key: string): string | undefined {
  const value = req?.headers[key]
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
    // The server records the outcome of a turn it stops itself, so a stopped turn leaves the queue at once.
    ...(input.signal ? { signal: input.signal, stopQueueWaitOnAbort: true } : {}),
    onTurnStart: input.onTurnStart,
    identity: {
      provider: "a2a-agent",
      externalId: input.peerAgentId,
      displayName: input.peerName,
    },
    // The Butler's house tools read a typed Sanctuary runtime from the tool context; the
    // Telegram sense attaches it, and a verified A2A friend's turn needs it too (without it
    // every Unraid read answered "Sanctuary runtime is unavailable"). The relationship
    // profile still decides which of those tools the peer may call.
    toolContext: {
      ...(isSanctuaryAgent(input.agentName) ? createSanctuaryToolContext(input.agentName) : {}),
      ...(input.relationshipAuthorization ? { relationshipAuthorization: input.relationshipAuthorization } : {}),
      ...(input.delegatedCommand ? { delegatedCommand: input.delegatedCommand } : {}),
    },
  })
  return { response: result.response }
}
/* v8 ignore stop */

/** The relationship that scopes a verified friend's A2A chat turn, from the agent's
 * own capability registry. No registry (or an invalid one) means no relationship,
 * which Sanctuary's tool selection turns into "no tools" for a remote turn. */
export function a2aChatRelationship(agentRoot: string, friend: FriendRecord, requestId: string): RelationshipAuthorizationEvaluator | undefined {
  let registry
  try {
    registry = loadRelationshipCapabilityRegistry(agentRoot)
  } catch {
    return undefined
  }
  return createRelationshipAuthorizationEvaluator({ friend, registry, requestId, requestPhase: "inbound" })
}

function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex")
}

function tokenHashScope(tokenHash: string): string {
  return `a2a-task-token:${tokenHash}`
}

function accessTokenScope(accessToken: string): string {
  return tokenHashScope(accessTokenHash(accessToken))
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

/**
 * A delegated command's id: a hash of the sender's DID, its signed message id and its signed issue time. A redelivery of
 * the same message names the same command, while a sender reusing a message id on a new message (possible once the
 * old one ages out of the seen ledger) gets a new command, so it can never ride an earlier command's owner notice or
 * effect record. A message without a binding (unbound, so refused upstream) falls back to a random id.
 */
export function commandIdFor(chat: { did: string; bindingId?: string; issuedAt?: string }): string {
  /* v8 ignore next -- unbound envelopes are refused before a delegated command is admitted @preserve */
  if (!chat.bindingId) return randomUUID()
  return createHash("sha256").update(JSON.stringify([chat.did, chat.bindingId, chat.issuedAt ?? ""])).digest("hex").slice(0, 32)
}

function refusalResponse(id: A2AJsonRpcRequest["id"], what: string, reason: string): A2AJsonRpcResponse {
  const refusal = receiveRefusalError(what, reason)
  return errorResponse(id, rejectionErrorCode(reason), refusal.message, refusal.data)
}

/** Map a friends `receiveShare` rejection reason → a JSON-RPC error code.
 * Malformed-shape reasons map to invalid-params (-32602); auth/trust/replay
 * rejections map to a dedicated A2A "rejected" code (-32003). */
function rejectionErrorCode(reason: string): number {
  if (reason === "malformed_message" || reason === "malformed_plaintext") return -32602
  return -32003
}

function senderHintFromMessage(req: http.IncomingMessage | undefined, inbound: A2AMessage): { idHint?: string; name: string } {
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

/** A friends sealed DataPart: opaque ciphertext addressed to one DID, so it is safe
 * to expose to the task holder (a sealed chat reply travels this way). */
function isSealedFriendsPart(part: A2AMessage["parts"][number]): boolean {
  const data = part.data
  return part.kind === "data" && !!data && typeof data === "object" && typeof data.sealed === "object" && data.sealed !== null && typeof data.recipientDid === "string"
}

function publicMessage(message: A2AMessage, style: A2AResponseStyle): A2AMessage {
  const parts = message.parts
    .filter((part) => part && typeof part === "object" && (typeof part.text === "string" || isSealedFriendsPart(part)))
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
  accessTokenHash: string
  contextId: string
  inbound: A2AMessage
  state: A2ATask["status"]["state"]
  response?: string
  /** Replaces the plaintext response with these parts (a sealed chat reply). */
  responseParts?: A2AMessage["parts"]
  clientTaskId?: string
  previousTask?: A2ATask
}): A2ATask {
  const now = new Date().toISOString()
  const history = [...(input.previousTask?.history ?? []), input.inbound]
  const previousA2A = input.previousTask ? taskA2AMetadata(input.previousTask) : {}
  const responseParts = input.responseParts ?? (input.response ? [{ text: input.response }] : undefined)
  const responseMessage: A2AMessage | undefined = responseParts
      ? {
        kind: "message",
        role: "ROLE_AGENT",
        taskId: input.taskId,
        contextId: input.contextId,
        messageId: randomUUID(),
        parts: responseParts,
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
        accessTokenHash: input.accessTokenHash,
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
  const journal = openInboundJournal<A2AInboundRecord>(agentRoot, "a2a")
  // Taken before the server listens: anything journaled after this belongs to this process's own live turns.
  const leftOver = journal.pending()
  const turnTimeoutMs = options.turnTimeoutMs ?? A2A_TURN_TIMEOUT_MS
  /** In-flight turns, so CancelTask and shutdown can stop them. */
  const activeTurns = new Set<{ task: string; controller: AbortController }>()
  // Set by close(): from then on nothing new starts, so a shutdown never spends attempts on turns it would kill.
  let closing = false
  const activeTaskKey = (taskId: string, tokenScope: string): string => `${tokenScope}\n${taskId}`
  /* v8 ignore next -- default runner crosses into the full live agent pipeline; shared-turn covers that pipeline and server tests inject a deterministic runner @preserve */
  const turnRunner = options.turnRunner ?? defaultTurnRunner

  // The inbound friends-DataPart bridge is available only when the agent has a
  // cryptographic identity (its did:key + X25519 unseal keys). Build its durable
  // stores once at start; without an identity, inbound stays on the text path.
  let inboundShareDeps: InboundShareDeps | undefined
  if (options.identity) {
    const friendsDir = `${agentRoot}/friends`
    const friendStore = new FileFriendStore(friendsDir)
    inboundShareDeps = {
      sodium: await ready(),
      store: friendStore,
      // The SAME canonical mission store the Slice-4 delegation tools use, so an
      // inbound `importCoordination` write lands where the read/prepare surface reads.
      missionStore: delegationStoresFor(agentRoot).missionStore,
      pinStore: new FileA2APinStore(agentRoot),
      seen: new FileA2ASeenLedger(agentRoot),
      didResolution: makeDidResolution({ sodium: await ready(), store: friendStore, agentName: options.agentName, notifyOwner: options.notifyOwner }),
      identity: options.identity,
    }
  }

  // Resolved failure reports are confirmed to the owner once the running version reaches the fix: now, after each
  // resolution, and on a timer, so a fix that lands with a restart is announced without anyone calling again.
  const confirmReports = async (): Promise<void> => {
    try {
      await dispatchPendingFailureReports(agentRoot, inboundShareDeps?.store ?? new FileFriendStore(`${agentRoot}/friends`))
      if (options.escalation) await confirmResolvedReports(agentRoot, { ...options.escalation, ...(inboundShareDeps ? { friends: inboundShareDeps.store } : {}) })
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_escalation_confirm_error", message: "confirming resolved failure reports failed", meta: { agentName: options.agentName, error: error instanceof Error ? error.message : String(error) } })
    }
  }

  // The message/send branch as one function, so a sealed message that arrives through the relay inbox runs exactly the
  // path a direct POST runs. `req` is absent for a relayed message: there are no HTTP headers to take a sender hint from.
  /**
   * A verified message carrying a signed `approvalAnswer`: forward it, unopened, to the Telegram sense and send back
   * its one-word outcome, sealed to the sender. It is never journaled and never reaches a model (review L4).
   */
  const answerRelayedApproval = async (
    rpcId: A2AJsonRpcRequest["id"],
    inbound: A2AMessage,
    senderDid: string,
    responseStyle: A2AResponseStyle,
  ): Promise<A2AJsonRpcResponse> => {
    const reply = await (options.forwardApprovalAnswer ?? forwardApprovalAnswer)({ socketPath: approvalRelaySocketPath(agentRoot), message: inbound })
    // receiveShare pinned the sender before it reported the message as completed.
    const pinned = inboundShareDeps!.pinStore.get(senderDid)!
    const responseParts = sealChatMessage({
      sodium: inboundShareDeps!.sodium, from: options.identity!, recipientDid: senderDid, recipientEd25519Pub: pinned.ed25519Pub,
      text: reply, ...(inbound.contextId ? { conversationId: inbound.contextId } : {}),
    }).parts
    const accessToken = randomUUID()
    const task = taskFor({ taskId: randomUUID(), accessTokenHash: accessTokenHash(accessToken), contextId: inbound.contextId ?? "default", inbound, state: "TASK_STATE_COMPLETED", response: reply, responseParts })
    taskStore.put(task, accessTokenScope(accessToken))
    return jsonResponse(rpcId, publicTask(task, accessToken, responseStyle, true))
  }

  const handleMessageSend = async (rpc: A2AJsonRpcRequest, req?: http.IncomingMessage, origin: A2AInboundOrigin = "direct"): Promise<A2AJsonRpcResponse> => {
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
        return refusalResponse(rpc.id, "result", imported.reason)
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
      const ackTask = taskFor({ taskId, accessTokenHash: accessTokenHash(accessToken), contextId, inbound, state: "TASK_STATE_COMPLETED", response: ackText })
      taskStore.put(ackTask, accessTokenScope(accessToken))
      return jsonResponse(rpc.id, publicTask(ackTask, accessToken, responseStyle, true))
    }

    // Inbound friends-DataPart branch (runs BEFORE the legacy text path). A
    // sealed DataPart is unwrapped + verified through the bridge; the turn is
    // then keyed on the VERIFIED sender DID (replacing the unauthenticated
    // sentinel). A non-friends (text) message falls through unchanged.
    let verifiedPeerAgentId: string | undefined
    let verifiedPeerName: string | undefined
    let verifiedShareText: string | undefined
    let verifiedChat: { did: string; friend?: FriendRecord; onBehalfOf?: "principal"; bindingId?: string; issuedAt?: string } | undefined
    if (inbound && inboundShareDeps && messageHasDataPart(inbound)) {
      const bridged = await receiveInboundShare(inbound, inboundShareDeps)
      if (bridged.outcome === "rejected") {
        return refusalResponse(rpc.id, "share", bridged.reason)
      }
      // A message with a data part always resolves to completed|rejected — the
      // bridge only returns "not-a-share" when there is NO data part, which the
      // `messageHasDataPart` gate above excludes. So this is the completed path.
      /* v8 ignore next -- "not-a-share" is unreachable here (gated by messageHasDataPart) @preserve */
      if (bridged.outcome === "completed") {
        verifiedPeerAgentId = bridged.verifiedDid
        verifiedPeerName = bridged.verifiedDid
        if (bridged.message?.approvalAnswer) {
          // An approval answer is never a turn: the Telegram sense, which owns the cards, checks and decides it.
          return answerRelayedApproval(rpc.id, inbound, bridged.verifiedDid, responseStyle)
        }
        if (bridged.message) {
          // Authenticated chat: the signed, sealed text IS the turn.
          verifiedShareText = bridged.message.text
          /* v8 ignore next -- a completed chat always has a friend record: an unknown DID reads as stranger and the message is refused @preserve */
          verifiedPeerName = bridged.friend?.name ?? bridged.verifiedDid
          verifiedChat = { did: bridged.verifiedDid, friend: bridged.friend, ...(bridged.message.onBehalfOf ? { onBehalfOf: bridged.message.onBehalfOf } : {}), bindingId: bridged.bindingId, issuedAt: bridged.message.issuedAt }
        } else {
          verifiedShareText = `[a2a] received ${bridged.friendsKind} (${bridged.status}) from ${bridged.verifiedDid}`
        }
      }
    }

    const text = verifiedShareText ?? textFromMessage(inbound)
    if (!inbound || !text) {
      return errorResponse(rpc.id, -32602, "SendMessage requires a text message")
    }
    if (text.length > MAX_A2A_MESSAGE_TEXT_CHARS) {
      return errorResponse(rpc.id, -32602, `SendMessage text exceeds ${MAX_A2A_MESSAGE_TEXT_CHARS} characters`)
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
      return errorResponse(rpc.id, -32001, "task not found")
    }
    if (continuationTask && isTerminalTaskState(continuationTask.status.state)) {
      return errorResponse(rpc.id, -32002, "task is terminal; start a new task")
    }
    const contextId = inbound.contextId ?? continuationTask?.contextId ?? "default"
    const taskId = continuationTask?.id ?? randomUUID()
    const accessToken = continuationToken && continuationTask ? continuationToken : randomUUID()
    const clientTaskId = continuationTask ? taskA2AMetadata(continuationTask).clientTaskId as string | undefined : inbound.taskId
    const record: A2AInboundRecord = {
      origin,
      responseStyle,
      taskId,
      accessTokenHash: accessTokenHash(accessToken),
      contextId,
      inbound,
      ...(clientTaskId ? { clientTaskId } : {}),
      ...(continuationTask ? { previousTask: continuationTask } : {}),
      peerAgentId,
      peerName,
      text,
      // Absent fields drop out when the record is written as JSON.
      ...(verifiedChat ? { verifiedChat: { did: verifiedChat.did, friendId: verifiedChat.friend?.id, onBehalfOf: verifiedChat.onBehalfOf, bindingId: verifiedChat.bindingId, issuedAt: verifiedChat.issuedAt } } : {}),
    }
    // Written down before anything runs, so a process that dies from here on leaves it pending, not lost.
    const inboundId = randomUUID()
    journal.record(inboundId, record)
    return runInboundTurn(rpc.id, inboundId, record, { accessToken, friend: verifiedChat?.friend })
  }

  /**
   * Record a visible failure for an inbound: the task ends FAILED with the reason, then the journal records the
   * outcome. The journal entry is settled even when the task cannot be written, so it is never left pending for the
   * life of the process.
   */
  const recordFailure = (inboundId: string, record: A2AInboundRecord, detail: string): void => {
    if (!journal.get(inboundId)) return
    const task = taskFor({
      taskId: record.taskId,
      accessTokenHash: record.accessTokenHash,
      contextId: record.contextId,
      inbound: record.inbound,
      state: "TASK_STATE_FAILED",
      response: detail,
      clientTaskId: record.clientTaskId,
      previousTask: record.previousTask,
    })
    try {
      taskStore.put(task, tokenHashScope(record.accessTokenHash))
    } catch (error) {
      emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_failed_task_write_error", message: "could not write an A2A message's FAILED task; its failure is still recorded", meta: { agentName: options.agentName, inboundId, error: error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error) } })
    }
    journal.settle(inboundId, "failed", detail)
  }

  const failureResponse = (rpcId: A2AJsonRpcRequest["id"], record: A2AInboundRecord, message: string, accessToken: string | undefined): A2AJsonRpcResponse =>
    // A replay has no token and no one waiting; an absent token drops out of the JSON.
    errorResponse(rpcId, -32000, message, { taskId: record.taskId, state: "TASK_STATE_FAILED", accessToken })

  /**
   * Run (or replay) one journaled inbound to its one outcome. `accessToken` is known only to the live request that
   * minted it; a replay has no one waiting on its reply.
   */
  const runInboundTurn = async (
    rpcId: A2AJsonRpcRequest["id"],
    inboundId: string,
    record: A2AInboundRecord,
    context: { accessToken?: string; friend?: FriendRecord },
  ): Promise<A2AJsonRpcResponse> => {
    if (closing) {
      // Recorded but not started, with no attempt spent: the next process replays it or records why not.
      return errorResponse(rpcId, -32000, AGENT_RESTARTING)
    }
    try {
      return await runRecordedInbound(rpcId, inboundId, record, context)
    } catch (error) {
      // Anything that throws before or around the turn still ends the inbound in a recorded failure.
      const detail = error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error)
      recordFailure(inboundId, record, detail)
      return failureResponse(rpcId, record, detail, context.accessToken)
    }
  }

  const runRecordedInbound = async (
    rpcId: A2AJsonRpcRequest["id"],
    inboundId: string,
    record: A2AInboundRecord,
    context: { accessToken?: string; friend?: FriendRecord },
  ): Promise<A2AJsonRpcResponse> => {
    const { accessToken, friend } = context
    const tokenScope = tokenHashScope(record.accessTokenHash)
    const respondWith = (task: A2ATask): A2AJsonRpcResponse =>
      jsonResponse(rpcId, publicTask(task, accessToken ?? "", record.responseStyle, accessToken !== undefined))
    let relationshipAuthorization = friend ? a2aChatRelationship(agentRoot, friend, record.taskId) : undefined
    // Only the server writes the delegated banner. Any turn that is not about to be admitted as a delegated command
    // (verified or not, including a plain unauthenticated text turn) gets a typed banner marked as the sender's own words.
    let turnText = record.verifiedChat?.onBehalfOf === "principal" ? record.text : shieldDelegatedBanner(record.text)
    let delegatedCommand: DelegatedCommandContext | undefined
    if (record.verifiedChat?.onBehalfOf === "principal") {
      // A delegated command runs with the principal's authority only after the
      // server, never the model, has checked the grant and told the principal.
      let registry
      try { registry = loadRelationshipCapabilityRegistry(agentRoot) } catch { registry = undefined }
      /* v8 ignore next -- a completed chat always carries the sender's friend record (see the receipt above) @preserve */
      if (!friend) throw new Error("verified chat has no friend record")
      const admission = await admitDelegatedCommand({ friend, did: record.verifiedChat.did, text: record.text, commandId: commandIdFor(record.verifiedChat), store: inboundShareDeps!.store, registry, options: options.delegation })
      if (!admission.ok) {
        // The code and the "delegated command refused: <reason>" prefix stay: the replay gate and older CLIs match them.
        // Only an active family peer is told why: anyone else gets no_grant whatever the real reason was (a broken trust file, a key mismatch), which stays in the local log and nerves.
        const activeFamily = friend.trustLevel === "family" && friend.admissionState === "active"
        const shown = activeFamily ? admission.reason : "no_grant"
        const guidance = delegationRefusalGuidance(shown, { legacyRecordGrant: activeFamily && friend.delegationGrant !== undefined })
        journal.settle(inboundId, "failed", `delegated command refused: ${admission.reason}`)
        return errorResponse(rpcId, -32004, `delegated command refused: ${shown} (${guidance.message}). Nothing ran. Next: ${guidance.next}`, { reason: shown, nothingRan: true, retry: guidance.retry, next: guidance.next })
      }
      relationshipAuthorization = admission.relationship
      turnText = admission.turnText
      delegatedCommand = admission.context
    }

    journal.beginAttempt(inboundId)
    const controller = new AbortController()
    const active = { task: activeTaskKey(record.taskId, tokenScope), controller }
    activeTurns.add(active)
    // The deadline first bounds the wait for a place in the turn queue, then starts again for the turn itself.
    let started = false
    let deadline = setTimeout(() => controller.abort(new A2ATurnStopped("deadline")), turnTimeoutMs)
    const onTurnStart = (): void => {
      // A runner that reports its start after the turn has ended must not leave a new deadline running.
      if (!activeTurns.has(active)) return
      started = true
      clearTimeout(deadline)
      deadline = setTimeout(() => controller.abort(new A2ATurnStopped("deadline")), turnTimeoutMs)
    }
    // A turn that ignores its signal still ends the wait: the stop is what the sender hears, whatever the turn does next.
    const stopped = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
    })
    stopped.catch(() => undefined)
    let turn: A2ATurnRunnerOutput
    try {
      taskStore.put(taskFor({ taskId: record.taskId, accessTokenHash: record.accessTokenHash, contextId: record.contextId, inbound: record.inbound, state: "TASK_STATE_WORKING", clientTaskId: record.clientTaskId, previousTask: record.previousTask }), tokenScope)
      turn = await Promise.race([
        turnRunner({
          agentName: options.agentName,
          peerAgentId: record.peerAgentId,
          peerName: record.peerName,
          sessionKey: record.contextId,
          message: turnText,
          signal: controller.signal,
          onTurnStart,
          ...(relationshipAuthorization ? { relationshipAuthorization } : {}),
          ...(delegatedCommand ? { delegatedCommand } : {}),
        }),
        stopped,
      ])
    } catch (error) {
      const stop = controller.signal.aborted ? (controller.signal.reason as A2ATurnStopped).reason : undefined
      if (stop === "canceled") {
        // CancelTask already wrote the CANCELED task; the turn's end must not overwrite it.
        journal.settle(inboundId, "canceled")
        return respondWith(taskStore.get(record.taskId, tokenScope)!)
      }
      if (stop === "shutdown" && record.origin === "relay") {
        // Nobody waits on a relayed message's reply: it stays pending, and the next process runs it again. A clean
        // shutdown is not the turn failing, so it gives its attempt back; only crashes use attempts up.
        journal.refundAttempt(inboundId)
        return errorResponse(rpcId, -32000, AGENT_RESTARTING)
      }
      const seconds = Math.round(turnTimeoutMs / 1000)
      const detail = stop === "shutdown"
        ? STOPPED_BEFORE_ANSWERING
        : stop === "deadline"
          ? started ? `the turn was stopped after ${seconds} s without finishing` : `the turn was stopped after ${seconds} s waiting for the turn ahead of it`
          : error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error)
      recordFailure(inboundId, record, detail)
      return failureResponse(rpcId, record, detail, accessToken)
    } finally {
      clearTimeout(deadline)
      activeTurns.delete(active)
    }
    try {
      return finishAnswered(rpcId, inboundId, record, turn.response, respondWith)
    } catch (error) {
      // The turn ran but its answer could not be stored: a visible failure, not an entry left pending.
      const detail = error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error)
      recordFailure(inboundId, record, detail)
      return failureResponse(rpcId, record, detail, accessToken)
    }
  }

  const finishAnswered = (
    rpcId: A2AJsonRpcRequest["id"],
    inboundId: string,
    record: A2AInboundRecord,
    response: string,
    respondWith: (task: A2ATask) => A2AJsonRpcResponse,
  ): A2AJsonRpcResponse => {
    const tokenScope = tokenHashScope(record.accessTokenHash)
    let responseParts: A2AMessage["parts"] | undefined
    if (record.verifiedChat) {
      // A verified chat's reply is sealed to the sender and stored sealed, so neither
      // the wire nor a later GetTask ever carries the plaintext.
      const pinned = inboundShareDeps?.pinStore.get(record.verifiedChat.did)
      /* v8 ignore next 5 -- receiveShare pins the verified sender before it reports a completed chat; refuse rather than reply in plaintext @preserve */
      if (!pinned) {
        const detail = "A2A chat reply cannot be sealed to the sender"
        recordFailure(inboundId, record, detail)
        return errorResponse(rpcId, -32003, detail)
      }
      responseParts = sealChatMessage({
        sodium: inboundShareDeps!.sodium,
        from: options.identity!,
        recipientDid: record.verifiedChat.did,
        recipientEd25519Pub: pinned.ed25519Pub,
        text: response,
        conversationId: record.contextId,
      }).parts
    }
    const task = taskFor({ taskId: record.taskId, accessTokenHash: record.accessTokenHash, contextId: record.contextId, inbound: record.inbound, state: "TASK_STATE_COMPLETED", response, responseParts, clientTaskId: record.clientTaskId, previousTask: record.previousTask })
    taskStore.put(task, tokenScope)
    journal.settle(inboundId, "answered")
    return respondWith(task)
  }

  /**
   * The inbounds an earlier process left pending. A direct one's sender saw its connection drop and can't receive a
   * late reply, so it is recorded as failed. A relayed one is run again, until it has used its attempts.
   */
  const replayOne = async (leftOverEntry: PendingInbound<A2AInboundRecord>): Promise<void> => {
    // Read again: it may have been settled since the list was taken, and its attempts are counted on disk.
    const entry = journal.get(leftOverEntry.id)
    if (!entry) return
    const record = entry.payload
    // The task was finished just before the process died, so the journal only catches up with it.
    const state = taskStore.get(record.taskId, tokenHashScope(record.accessTokenHash))?.status.state
    if (state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_CANCELED") {
      journal.settle(entry.id, state === "TASK_STATE_COMPLETED" ? "answered" : "canceled")
      return
    }
    if (record.origin === "direct") {
      recordFailure(entry.id, record, STOPPED_BEFORE_ANSWERING)
      return
    }
    if (entry.attempts >= MAX_INBOUND_ATTEMPTS) {
      recordFailure(entry.id, record, `stopped after ${entry.attempts} attempts without an answer`)
      return
    }
    if (record.verifiedChat?.onBehalfOf === "principal") {
      // It may already have acted with the principal's authority, and its grant was checked only for that moment.
      recordFailure(entry.id, record, "a delegated command is not run again after a restart; send it again")
      return
    }
    const friendId = record.verifiedChat?.friendId
    const friend = friendId && inboundShareDeps ? await inboundShareDeps.store.get(friendId) ?? undefined : undefined
    if (record.verifiedChat && !friend) {
      recordFailure(entry.id, record, "the sender's friend record or this agent's A2A identity is gone, so the message cannot be answered")
      return
    }
    emitNervesEvent({ component: "channels", event: "channel.a2a_inbound_replayed", message: "replaying a relayed message an earlier process left pending", meta: { agentName: options.agentName, inboundId: entry.id, attempts: entry.attempts } })
    await runInboundTurn(null, entry.id, record, { friend })
  }

  const replayPendingInbound = async (): Promise<void> => {
    for (const entry of leftOver) {
      if (closing) break
      try {
        await replayOne(entry)
      } catch (error) {
        // Counted, so a message that throws every time is failed once it has used its attempts instead of
        // blocking every start; the messages behind it still run.
        try { journal.beginAttempt(entry.id) } catch { /* the event below still reports the failure */ }
        emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_inbound_replay_error", message: "replaying a pending A2A message failed; it stays pending for the next start", meta: { agentName: options.agentName, inboundId: entry.id, error: error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error) } })
      }
    }
  }

  let relayInbox: RelayInboxHandle | undefined
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
      if (isOutboxMethod(rpc.method)) {
        // Peer outbox methods: signed and sealed like a chat, access decided here from the verified friend record.
        const outboxInbound = messageFromParams(rpc.params)
        if (!outboxInbound || !inboundShareDeps) {
          writeJson(res, 200, errorResponse(rpc.id, OUTBOX_ERROR_REFUSED, "outbox calls need a signed message and an A2A identity"))
          return
        }
        const bridged = await receiveInboundShare({ ...outboxInbound, kind: outboxInbound.kind ?? "message" }, inboundShareDeps)
        if (bridged.outcome === "rejected") {
          writeJson(res, 200, refusalResponse(rpc.id, "outbox call", bridged.reason))
          return
        }
        if (bridged.outcome !== "completed" || !bridged.message) {
          writeJson(res, 200, errorResponse(rpc.id, OUTBOX_ERROR_REFUSED, "outbox calls must be a signed chat message"))
          return
        }
        const command = parseOutboxCommand(bridged.message.text)
        if (!command || command.method !== rpc.method) {
          writeJson(res, 200, errorResponse(rpc.id, OUTBOX_ERROR_INVALID, "the signed method does not match the requested method"))
          return
        }
        const ownRelay = relayInbox?.registration()
        const outcome = await handleOutboxCommand({
          agentRoot, friend: bridged.friend, method: command.method, params: command.params, verifiedDid: bridged.verifiedDid,
          relayContact: ownRelay ? { url: ownRelay.relayUrl, handle: ownRelay.handle, sendCredential: ownRelay.sendCredential } : null,
        })
        if (!outcome.ok) {
          writeJson(res, 200, errorResponse(rpc.id, outcome.code, outcome.message))
          return
        }
        if (command.method === "report/resolve") await confirmReports()
        /* v8 ignore next -- receiveShare pins the verified sender before it reports a completed message @preserve */
        const outboxPinned = inboundShareDeps.pinStore.get(bridged.verifiedDid)!
        const contextId = outboxInbound.contextId ?? "default"
        const reply = sealChatMessage({
          sodium: inboundShareDeps.sodium,
          from: options.identity!,
          recipientDid: bridged.verifiedDid,
          recipientEd25519Pub: outboxPinned.ed25519Pub,
          text: JSON.stringify(outcome.result),
          conversationId: contextId,
        })
        writeJson(res, 200, jsonResponse(rpc.id, { kind: "message", role: "ROLE_AGENT", messageId: randomUUID(), contextId, parts: reply.parts }))
        return
      }

      if (rpc.method === "SendMessage" || rpc.method === "message/send") {
        writeJson(res, 200, await handleMessageSend(rpc, req))
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
        const canceledKey = activeTaskKey(taskId, tokenScope)
        for (const active of [...activeTurns].filter((turn) => turn.task === canceledKey)) active.controller.abort(new A2ATurnStopped("canceled"))
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

  await confirmReports()
  const confirmTimer = setInterval(() => { void confirmReports() }, options.escalation?.confirmIntervalMs ?? ESCALATION_CONFIRM_INTERVAL_MS)
  confirmTimer.unref()

  if (options.relay && inboundShareDeps) {
    const seen = inboundShareDeps.seen as FileA2ASeenLedger
    relayInbox = startRelayInbox({
      ...options.relay,
      // Each old relay's failure clock, and a retirement waiting only for its vault write, survive a restart here.
      retirements: fileRelayRetirements(agentRoot),
      did: inboundShareDeps.identity.did,
      agentName: options.agentName,
      handle: (rpc) => handleMessageSend(rpc, undefined, "relay"),
      // Asked only after a handler throws: was this copy verified (and so recorded) before it failed?
      seen: seen.has.bind(seen),
    })
  }

  const replayed = replayPendingInbound()

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
    ...(relayInbox ? { relay: relayInbox } : {}),
    replayed,
    close: () => new Promise<void>((resolve, reject) => {
      closing = true
      for (const active of activeTurns) active.controller.abort(new A2ATurnStopped("shutdown"))
      clearInterval(confirmTimer)
      relayInbox?.stop()
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
