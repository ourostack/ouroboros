// Shared turn runner for non-interactive senses (MCP, future senses).
// Follows the CLI pattern: resolves context, constructs InboundTurnInput,
// calls handleInboundTurn, collects response text, detects ponder deferral.
//
// Does NOT refactor CLI — CLI is stable with 2280+ tests. This is a new
// code path for new senses that follows the same pipeline pattern.

import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks } from "../heart/core"
import { runAgent } from "../heart/core"
import { getAgentRoot } from "../heart/identity"
import { sanitizeKey } from "../heart/config"
import { stampIngressRelations, stampIngressTime, type SessionEvent, type SessionIngressRelations } from "../heart/session-events"
import { loadSession } from "../mind/context"
import { buildSystem, flattenSystemPrompt } from "../mind/prompt"
import { getChannelCapabilities, FriendResolver, FileFriendStore, accumulateFriendTokens } from "@ouro.bot/friends"
import type { IdentityProvider, Channel } from "@ouro.bot/friends"
import { getPendingDir, drainPending } from "../mind/pending"
import { postTurnTrim, deferPostTurnPersist } from "../mind/context"
import { enforceTrustGate } from "./trust-gate"
import { handleInboundTurn, type InboundTurnInput } from "./pipeline"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import type { RuntimeMcpServers } from "../repertoire/mcp-manager"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolContext } from "../repertoire/tools-base"
import { readSessionTransaction, withSessionTurnLease, type SessionTurnLease } from "../mind/session-transaction"
import type { OrientationFrame } from "../heart/orientation-frame"

const RESPONSE_CAP = 50_000
const OUTWARD_DELIVERY_TOOL_ACKS = new Map([
  ["settle", "(delivered)"],
  ["speak", "(spoken)"],
])

/**
 * Strip MiniMax-style `<think>...</think>` reasoning blocks from a response
 * string. Handles unclosed open tags (treats everything from `<think>` to
 * end of string as reasoning) and multiple blocks in sequence. Returns the
 * trimmed remainder.
 */
export function stripThinkBlocks(input: string): string {
  let out = input
  // Closed blocks first (greedy match removed by repeatedly slicing the leftmost pair).
  for (;;) {
    const open = out.indexOf("<think>")
    if (open === -1) break
    const close = out.indexOf("</think>", open + "<think>".length)
    if (close === -1) {
      // Unclosed — drop everything from <think> onward.
      out = out.slice(0, open)
      break
    }
    out = out.slice(0, open) + out.slice(close + "</think>".length)
  }
  return out.trim()
}

function assistantContentText(content: unknown): string | null {
  if (typeof content !== "string") return null
  const trimmed = content.trim()
  return trimmed ? trimmed : null
}

function parseToolStringArg(toolCall: unknown, toolName: string, argName: string): string | null {
  if (!toolCall || typeof toolCall !== "object") return null
  const fn = (toolCall as { function?: { name?: unknown; arguments?: unknown } }).function
  if (fn?.name !== toolName || typeof fn.arguments !== "string") return null

  try {
    const parsed = JSON.parse(fn.arguments) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>)[argName]
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  } catch {
    return null
  }
}

function hasDeliveredToolResult(
  messages: ChatCompletionMessageParam[],
  assistantIndex: number,
  toolCallId: unknown,
  toolName: "settle" | "speak",
): boolean {
  if (typeof toolCallId !== "string" || !toolCallId.trim()) return false
  const expectedAck = OUTWARD_DELIVERY_TOOL_ACKS.get(toolName)!

  for (let index = assistantIndex + 1; index < messages.length; index++) {
    const message = messages[index] as ChatCompletionMessageParam & { tool_call_id?: unknown }
    if (message.role !== "tool") return false
    if (
      message.tool_call_id === toolCallId
      && typeof message.content === "string"
      && message.content.trim() === expectedAck
    ) {
      return true
    }
  }

  return false
}

function outwardDeliveryTextFromAssistantTools(
  messages: ChatCompletionMessageParam[],
  assistantIndex: number,
): string | null {
  const assistant = messages[assistantIndex] as ChatCompletionMessageParam & { tool_calls?: unknown }
  const toolCalls = assistant.tool_calls as unknown[]

  const delivered: string[] = []
  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index]
    const toolCallId = toolCall && typeof toolCall === "object"
      ? (toolCall as { id?: unknown }).id
      : undefined
    const settleAnswer = parseToolStringArg(toolCall, "settle", "answer")
    if (settleAnswer && hasDeliveredToolResult(messages, assistantIndex, toolCallId, "settle")) {
      delivered.push(settleAnswer)
      continue
    }

    const spokenMessage = parseToolStringArg(toolCall, "speak", "message")
    if (spokenMessage && hasDeliveredToolResult(messages, assistantIndex, toolCallId, "speak")) {
      delivered.push(spokenMessage)
    }
  }

  return delivered.length > 0 ? delivered.join("\n") : null
}

/**
 * Recover the text that actually reached a friend in an outward sense turn.
 *
 * Ouro runs outward channels in tool-required mode. That means the visible
 * response may be a `settle({ answer })` or `speak({ message })` tool call
 * whose assistant message has `content: null`. The authoritative delivery
 * signal is the following tool ack:
 *
 * - `(delivered)` for `settle.answer`
 * - `(spoken)` for `speak.message`
 *
 * Private-runtime `(settled)`, malformed tool arguments, rejected tools, and
 * interrupted tool-call sequences are not outward speech. Sense transports
 * that need to replay the turn later (Voice/Twilio TTS, future meeting audio)
 * should use this helper instead of reading `assistant.content` directly.
 */
export function extractOutwardSenseDeliveryText(messages: ChatCompletionMessageParam[]): string | null {
  const assistantIndex = messages.findLastIndex((message) => message.role === "assistant")
  if (assistantIndex < 0) return null
  const assistant = messages[assistantIndex] as ChatCompletionMessageParam & { tool_calls?: unknown }
  return Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0
    ? outwardDeliveryTextFromAssistantTools(messages, assistantIndex)
    : assistantContentText(assistant.content)
}

export interface RunSenseTurnOptions {
  /** Agent name (bundle name). */
  agentName: string
  /** Channel identifier (e.g. "mcp"). */
  channel: Channel
  /** Session key for this conversation. */
  sessionKey: string
  /** Friend ID for identity resolution. */
  friendId: string
  /** Optional external identity override for remote senses such as A2A. */
  identity?: {
    provider: IdentityProvider
    externalId: string
    displayName: string
    tenantId?: string
  }
  /** The user's message text. */
  userMessage: string
  /** Optional authenticated transport binding for the new user event. */
  ingressRelations?: SessionIngressRelations
  /** Exact already-committed user ingress claimed by a durable transport worker. */
  precommittedIngress?: { eventId: string; reference: string }
  /** Latency profile. Live turns keep local session state but skip remote sync and pre-model kept-note judging. */
  latencyMode?: "standard" | "live"
  /** Optional transport delivery hook for outward `speak`/`settle` text. */
  deliverySink?: OutwardSenseDeliverySink
  /** Optional transport-specific controls surfaced to tools during this turn. */
  toolContext?: Partial<ToolContext>
  /** Final sense-owned authorization/context refresh at the shared pipeline's pre-provider boundary. */
  prepareRunAgentOptions?: InboundTurnInput["prepareRunAgentOptions"]
  /** Sense-owned fallback enabled only after its required-read contract records complete current evidence. */
  emptyResponseFallback?: () => string | undefined
  /** Truth-bearing presentation context for a transport-specific turn trigger. */
  orientationFrame?: OrientationFrame
  /** Builds a durable approval coordinator after the exact leased session path/revision are known. */
  approvalCoordinatorFactory?: (context: { sessionPath: string; baseSessionRevision: string }) => import("../heart/core").ApprovalCoordinator
  /**
   * Per-turn, per-agent runtime MCP server overrides (e.g. Workbench's
   * `ouro_workbench`). Merged into the agent's toolset with highest precedence
   * for THIS turn only. Threaded as parameter data from the `agent.senseTurn`
   * command — never stored as module state, so it cannot leak into a concurrent
   * turn for a different agent.
   */
  runtimeMcpServers?: RuntimeMcpServers
  /** Test seam for the same production whole-turn lease wrapper. */
  _withSessionTurnLease?: <T>(sessionPath: string, work: (lease: SessionTurnLease) => Promise<T>) => Promise<T>
  /** Mutable per-turn metrics survive a rejected turn for durable transport receipts. */
  turnMetricsObserver?: { providerInvocationCount: number; toolInvocationCount: number }
}

export type OutwardSenseDeliveryKind = "speak" | "settle" | "text"

export interface OutwardSenseDelivery {
  kind: OutwardSenseDeliveryKind
  text: string
}

export interface OutwardSenseDeliveryFailure extends OutwardSenseDelivery {
  error: string
}

export interface OutwardSenseDeliverySink {
  onDelivery(delivery: OutwardSenseDelivery): Promise<void> | void
}

export interface RunSenseTurnResult {
  /** The agent's text response (accumulated from onTextChunk). */
  response: string
  /** Deprecated compatibility field. Ponder no longer implies outward deferral. */
  ponderDeferred: boolean
  /** Outward deliveries that reached the channel delivery hook, or were observed when no hook was configured. */
  deliveries: OutwardSenseDelivery[]
  /** Delivery failures observed after the model's terminal answer. Mid-turn `speak` failures are returned to the model immediately. */
  deliveryFailures: OutwardSenseDeliveryFailure[]
  /** Actual model invocation callbacks observed during this turn. */
  providerInvocationCount?: number
  /** Actual tool invocation callbacks observed during this turn. */
  toolInvocationCount?: number
  /** Exact durable session path used by this turn, for transport reconciliation. */
  sessionPath?: string
  /** Existing canonical session event IDs aligned with successful outward deliveries. */
  causalSessionEventIds?: Array<string | null>
  /** Exact canonical assistant event recovered by the transcript-readback fallback. */
  responseCausalSessionEventId?: string
}

function hasAcceptedOutwardSessionAck(events: SessionEvent[], assistantIndex: number, toolCallId: string, toolName: "speak" | "settle"): boolean {
  const expectedAck = OUTWARD_DELIVERY_TOOL_ACKS.get(toolName)!
  for (let index = assistantIndex + 1; index < events.length; index++) {
    const candidate = events[index]!
    if (candidate.role !== "tool") return false
    if (candidate.toolCallId === toolCallId && typeof candidate.content === "string" && candidate.content.trim() === expectedAck) return true
  }
  return false
}

function newOutwardCoordinates(
  events: SessionEvent[],
  existingEventIds: ReadonlySet<string>,
): Array<{ kind: OutwardSenseDeliveryKind; eventId: string }> {
  return events.flatMap((event, eventIndex): Array<{ kind: OutwardSenseDeliveryKind; eventId: string }> => {
    if (existingEventIds.has(event.id) || event.role !== "assistant") return []
    const outwardTools = event.toolCalls.filter((call) => {
      if (call.function.name !== "speak" && call.function.name !== "settle") return false
      return hasAcceptedOutwardSessionAck(events, eventIndex, call.id, call.function.name)
    })
    if (outwardTools.length > 0) return outwardTools.map((call) => ({ kind: call.function.name as "speak" | "settle", eventId: event.id }))
    if (event.toolCalls.length > 0) return []
    return typeof event.content === "string" && event.content.trim() ? [{ kind: "text" as const, eventId: event.id }] : []
  })
}

function newestPlainAssistantText(messages: ChatCompletionMessageParam[]): string | null {
  const message = messages.findLast((candidate) =>
    candidate.role === "assistant"
    && (!("tool_calls" in candidate) || !Array.isArray(candidate.tool_calls) || candidate.tool_calls.length === 0)
    && typeof candidate.content === "string"
    && candidate.content.trim().length > 0,
  )
  return message ? assistantContentText(message.content) : null
}

function causalSessionEventIds(
  events: SessionEvent[],
  existingEventIds: ReadonlySet<string>,
  attempts: Array<{ kind: OutwardSenseDeliveryKind; delivered: boolean }>,
): Array<string | null> {
  const coordinates = newOutwardCoordinates(events, existingEventIds)
  const aligned = coordinates.length === attempts.length && coordinates.every((coordinate, index) => coordinate.kind === attempts[index]!.kind)
    ? coordinates.map((coordinate) => coordinate.eventId)
    : attempts.map(() => null)
  return attempts.flatMap((attempt, index) => attempt.delivered ? [aligned[index] ?? null] : [])
}

export function getSenseSessionPath(agentName: string, friendId: string, channel: Channel, sessionKey: string, agentRootOverride?: string): string {
  return path.join(agentRootOverride ?? getAgentRoot(agentName), "state", "sessions", friendId, channel, `${sanitizeKey(sessionKey)}.json`)
}

/**
 * Run a single agent turn through the inbound pipeline.
 * Caller provides channel, session key, friend, and message;
 * this function handles all pipeline wiring.
 */
export async function runSenseTurn(options: RunSenseTurnOptions): Promise<RunSenseTurnResult> {
  const { agentName, channel, sessionKey, friendId, userMessage } = options

  emitNervesEvent({
    component: "senses",
    event: "senses.shared_turn_start",
    message: "shared turn runner starting",
    meta: { agentName, channel, sessionKey, friendId },
  })

  // Resolve context
  const agentRoot = getAgentRoot(agentName)
  const friendsPath = path.join(agentRoot, "friends")
  const friendStore = new FileFriendStore(friendsPath)
  const capabilities = getChannelCapabilities(channel)

  // If friendId looks like a UUID, look up the friend record directly and use its identity.
  // Otherwise, resolve as a local user (same pattern as CLI sense).
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(friendId)
  let resolverParams: { provider: IdentityProvider; externalId: string; displayName: string; channel: string; tenantId?: string }
  if (options.identity) {
    resolverParams = {
      provider: options.identity.provider,
      externalId: options.identity.externalId,
      displayName: options.identity.displayName,
      channel,
      ...(options.identity.tenantId ? { tenantId: options.identity.tenantId } : {}),
    }
  } else if (isUuid) {
    const existingFriend = await friendStore.get(friendId)
    if (existingFriend) {
      // Use the friend's first external ID for resolver context
      const ext = existingFriend.externalIds?.[0]
      resolverParams = {
        provider: (ext?.provider ?? "local") as IdentityProvider,
        externalId: ext?.externalId ?? friendId,
        displayName: existingFriend.name ?? friendId,
        channel,
      }
    } else {
      resolverParams = { provider: "local", externalId: friendId, displayName: friendId, channel }
    }
  } else {
    // Treat as local user identity (username@hostname pattern)
    const username = os.userInfo().username
    resolverParams = { provider: "local", externalId: username, displayName: username, channel }
  }
  const resolver = new FriendResolver(friendStore, resolverParams)

  // Initialize MCP manager so MCP tools appear as first-class tools in the agent's tool list.
  // Runtime MCP servers (e.g. Workbench's ouro_workbench) are passed per-turn for THIS agent only.
  const mcpManager = await getSharedMcpManager(
    options.runtimeMcpServers ? { runtimeServers: options.runtimeMcpServers } : undefined,
  ) ?? undefined

  // Session path and loading
  const sessionDir = path.join(agentRoot, "state", "sessions", friendId, channel)
  fs.mkdirSync(sessionDir, { recursive: true })
  const sessPath = getSenseSessionPath(agentName, friendId, channel, sessionKey, agentRoot)
  const runWithLease = options._withSessionTurnLease ?? withSessionTurnLease
  return runWithLease(sessPath, async (sessionTurnLease) => {
  const baseSessionRevision = readSessionTransaction(sessPath, sessionTurnLease).revision
  const existing = loadSession(sessPath)
  if (options.precommittedIngress) {
    const event = existing?.events?.find((candidate) => candidate.id === options.precommittedIngress!.eventId)
    const latestUserEvent = existing?.events?.filter((candidate) => candidate.role === "user").at(-1)
    if (!event || event !== latestUserEvent || event.role !== "user" || event.content !== userMessage
      || !event.relations.references.includes(options.precommittedIngress.reference)) {
      throw new Error("shared turn precommitted ingress is missing, mismatched, or no longer current")
    }
  }
  const existingEventIds = new Set(existing?.events?.map((event) => event.id) ?? [])
  let sessionState = existing?.state
  let persistPromise: Promise<SessionEvent[]> | undefined
  const sessionMessages: ChatCompletionMessageParam[] = existing?.messages && existing.messages.length > 0
    ? existing.messages
    : [{ role: "system", content: flattenSystemPrompt(await buildSystem(channel, {}, undefined)) }]
  const preTurnMessageCount = sessionMessages.length

  // Pending dir
  const pendingDir = getPendingDir(agentName, friendId, channel, sessionKey)

  // Accumulate outward text through the same callback boundary used by chat
  // channels. `speak` flushes pending text immediately; `settle` is delivered
  // once the turn completes.
  let committedResponseText = ""
  let pendingResponseText = ""
  let terminalDeliveryKind: OutwardSenseDeliveryKind = "text"
  const deliveries: OutwardSenseDelivery[] = []
  const deliveryFailures: OutwardSenseDeliveryFailure[] = []
  const deliveryAttempts: Array<{ kind: OutwardSenseDeliveryKind; delivered: boolean }> = []
  let providerInvocationCount = 0
  let toolInvocationCount = 0
  let hadReasoningChunk = false

  const commitResponseText = (text: string): void => {
    const cleaned = stripThinkBlocks(text)
    /* v8 ignore next -- deliverPending strips first; this is a defensive direct-call guard @preserve */
    if (!cleaned) return
    committedResponseText = committedResponseText
      ? `${committedResponseText}\n${cleaned}`
      : cleaned
  }

  const deliveryErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const deliverPending = async (
    kind: OutwardSenseDeliveryKind,
    optionsForDelivery: { throwOnError: boolean },
  ): Promise<void> => {
    const text = stripThinkBlocks(pendingResponseText)
    pendingResponseText = ""
    if (!text) return

    const delivery: OutwardSenseDelivery = { kind, text }
    const attempt = { kind, delivered: false }
    deliveryAttempts.push(attempt)
    try {
      await options.deliverySink?.onDelivery(delivery)
      attempt.delivered = true
      deliveries.push(delivery)
      commitResponseText(text)
    } catch (error) {
      const failure = { ...delivery, error: deliveryErrorMessage(error) }
      deliveryFailures.push(failure)
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.shared_turn_delivery_error",
        message: "shared turn outward delivery failed",
        meta: { agentName, channel, sessionKey, friendId, kind, error: failure.error, textLength: text.length },
      })
      if (optionsForDelivery.throwOnError) throw error
      commitResponseText(text)
    }
  }

  /* v8 ignore start — callback stubs are exercised through the pipeline integration */
  const callbacks: ChannelCallbacks = {
    settleOutputMode: "retractable_buffer",
    onModelStart: () => { providerInvocationCount += 1; if (options.turnMetricsObserver) options.turnMetricsObserver.providerInvocationCount += 1 },
    onModelStreamStart: () => {},
    onTextChunk: (chunk: string) => { pendingResponseText += chunk },
    onReasoningChunk: () => { hadReasoningChunk = true },
    onToolStart: () => { toolInvocationCount += 1; if (options.turnMetricsObserver) options.turnMetricsObserver.toolInvocationCount += 1 },
    onToolEnd: (name: string, _summary: string, success: boolean) => {
      if (name === "settle" && success) terminalDeliveryKind = "settle"
    },
    onError: () => {},
    onClearText: () => { pendingResponseText = "" },
    flushNow: () => deliverPending("speak", { throwOnError: true }),
  }
  /* v8 ignore stop */

  // Run the pipeline
  const inboundMessages: ChatCompletionMessageParam[] = []
  if (!options.precommittedIngress) {
    const userMsg: ChatCompletionMessageParam = { role: "user", content: userMessage }
    stampIngressTime(userMsg)
    if (options.ingressRelations) stampIngressRelations(userMsg, options.ingressRelations)
    inboundMessages.push(userMsg)
  }
  const turnResult = await handleInboundTurn({
    channel,
    latencyMode: options.latencyMode,
    sessionKey,
    capabilities,
    messages: inboundMessages,
    callbacks,
    sessionTurnLease,
    /* v8 ignore start — delegation wrappers; pipeline integration tested separately */
    friendResolver: { resolve: () => resolver.resolve() },
    sessionLoader: {
      loadOrCreate: () => Promise.resolve({
        messages: sessionMessages,
        sessionPath: sessPath,
        state: sessionState,
        events: existing?.events,
        structuredOutputs: existing?.structuredOutputs,
      }),
    },
    /* v8 ignore stop */
    pendingDir,
    friendStore,
    provider: resolverParams.provider,
    externalId: resolverParams.externalId,
    tenantId: resolverParams.tenantId,
    enforceTrustGate,
    drainPending,
    runAgentOptions: {
      mcpManager,
      ...(options.approvalCoordinatorFactory ? { approvalCoordinator: options.approvalCoordinatorFactory({ sessionPath: sessPath, baseSessionRevision }) } : {}),
      ...(options.latencyMode === "live" ? { skipKeptNotes: true } : {}),
      ...(options.orientationFrame ? { orientationFrame: options.orientationFrame } : {}),
      toolContext: {
        signin: async () => undefined,
        ...(options.toolContext ? options.toolContext as ToolContext : {}),
        currentUserMessage: userMessage,
      },
    },
    ...(options.prepareRunAgentOptions ? { prepareRunAgentOptions: options.prepareRunAgentOptions } : {}),
    /* v8 ignore start — delegation wrappers; these just forward to the real functions */
    runAgent: (msgs, cb, ch, sig, opts) => runAgent(msgs, cb, ch, sig, opts),
    postTurn: (turnMessages, sessionPathArg, usage, hooks, state) => {
      const prepared = postTurnTrim(turnMessages, usage, hooks)
      sessionState = state
      persistPromise = deferPostTurnPersist(sessionPathArg, prepared, usage, state)
    },
    /* v8 ignore stop */
    accumulateFriendTokens,
  })

  if (turnResult.gateResult && !turnResult.gateResult.allowed) {
    const blockedResponse = "autoReply" in turnResult.gateResult
      ? turnResult.gateResult.autoReply
      : `(blocked by trust gate: ${turnResult.gateResult.reason})`
    return {
      response: blockedResponse,
      ponderDeferred: false,
      deliveries,
      deliveryFailures,
      providerInvocationCount,
      toolInvocationCount,
      sessionPath: sessPath,
    }
  }

  const persistedEvents = persistPromise ? await persistPromise : []
  const finalDeliveryKind = terminalDeliveryKind as OutwardSenseDeliveryKind
  const acceptedTerminalOutcome = turnResult.turnOutcome === "settled" || turnResult.turnOutcome === "blocked"
  const failoverText = turnResult.turnOutcome === "errored" ? turnResult.failoverMessage?.trim() : undefined
  const expectsOutwardResponse = acceptedTerminalOutcome || turnResult.turnOutcome === "command" || Boolean(failoverText)
  const hadPendingCallbackText = stripThinkBlocks(pendingResponseText).length > 0
  let recoveredTerminalEventId: string | undefined
  if (acceptedTerminalOutcome) {
    const completionText = turnResult.completion?.answer.trim()
    const currentTurnMessages = Array.isArray(turnResult.messages) ? turnResult.messages.slice(preTurnMessageCount) : []
    const plainTerminalText = newestPlainAssistantText(currentTurnMessages)
    const acknowledgedDeliveryText = finalDeliveryKind === "settle"
      ? extractOutwardSenseDeliveryText(currentTurnMessages)
      : null
    const authoritativeText = completionText || acknowledgedDeliveryText || plainTerminalText
    if (authoritativeText) pendingResponseText = authoritativeText
    else pendingResponseText = ""
    if (!hadPendingCallbackText && plainTerminalText) recoveredTerminalEventId = newOutwardCoordinates(persistedEvents, existingEventIds).at(-1)?.eventId
  } else if (turnResult.turnOutcome === "command") {
    // Slash-command text is emitted directly by the pipeline and has no assistant event.
  } else if (failoverText) {
    pendingResponseText = failoverText
  } else {
    pendingResponseText = ""
  }
  await deliverPending(finalDeliveryKind, { throwOnError: false })

  const ponderDeferred = false

  // Build response
  let finalResponse: string
  let responseCausalSessionEventId = recoveredTerminalEventId
  if (committedResponseText.length === 0) {
    if (!expectsOutwardResponse) {
      finalResponse = ""
    } else {
      // The terminal turn had no committed text — check its session transcript for the delivered answer.
      const postTurnSession = loadSession(sessPath)
      const emptyFallback = options.emptyResponseFallback?.()
      if (postTurnSession?.messages) {
        const recovered = extractOutwardSenseDeliveryText(postTurnSession.messages.slice(preTurnMessageCount))
        finalResponse = recovered ?? emptyFallback ?? (hadReasoningChunk ? "" : "(agent responded but response was empty)")
        if (recovered) responseCausalSessionEventId = newOutwardCoordinates(persistedEvents, existingEventIds).at(-1)?.eventId
      } else {
        finalResponse = emptyFallback ?? (hadReasoningChunk ? "" : "(agent responded but response was empty)")
      }
    }
  } else {
    finalResponse = committedResponseText
  }

  // Strip MiniMax-style <think>...</think> blocks from the final response.
  // When a reasoning-style model emits only a think block and no final answer
  // (no settle tool call, no post-think text), the readback path above
  // surfaces the raw saved assistant content — which includes the think tags
  // and renders as empty (or as raw reasoning) on MCP/CLI clients. Strip
  // here so the caller sees the actual delivered text. If only reasoning
  // came through and nothing else, surface a clear diagnostic message
  // instead of a blank response so the operator knows what happened.
  finalResponse = stripThinkBlocks(finalResponse)
  if (finalResponse.length === 0 && expectsOutwardResponse) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.shared_turn_only_reasoning",
      message: "agent produced only <think> reasoning with no final answer — likely a model that closed the think tag without continuing",
      meta: { agentName, channel, sessionKey, friendId },
    })
    finalResponse = "(agent produced reasoning but no final answer this turn — try again, or check the session transcript for the trace)"
  }

  // Cap response length
  if (finalResponse.length > RESPONSE_CAP) {
    finalResponse = finalResponse.slice(0, RESPONSE_CAP) + "\n\n[truncated — response exceeded 50K characters]"
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.shared_turn_end",
    message: "shared turn runner complete",
    meta: { agentName, channel, sessionKey, friendId, ponderDeferred, responseLength: finalResponse.length },
  })

  return {
    response: finalResponse,
    ponderDeferred,
    deliveries,
    deliveryFailures,
    providerInvocationCount,
    toolInvocationCount,
    sessionPath: sessPath,
    ...(deliveries.length > 0 ? { causalSessionEventIds: causalSessionEventIds(persistedEvents, existingEventIds, deliveryAttempts) } : {}),
    ...(responseCausalSessionEventId ? { responseCausalSessionEventId } : {}),
  }
  })
}
