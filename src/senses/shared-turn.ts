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
import { stampIngressTime } from "../heart/session-events"
import { loadSession } from "../mind/context"
import { buildSystem, flattenSystemPrompt } from "../mind/prompt"
import { getChannelCapabilities } from "../mind/friends/channel"
import { FriendResolver } from "../mind/friends/resolver"
import { FileFriendStore } from "../mind/friends/store-file"
import type { IdentityProvider } from "../mind/friends/types"
import { getPendingDir, drainPending } from "../mind/pending"
import { postTurnTrim, deferPostTurnPersist } from "../mind/context"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import { enforceTrustGate } from "./trust-gate"
import { handleInboundTurn } from "./pipeline"
import type { Channel } from "../mind/friends/types"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { emitNervesEvent } from "../nerves/runtime"

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
  if (!Array.isArray(assistant.tool_calls)) return null

  const delivered: string[] = []
  for (let index = 0; index < assistant.tool_calls.length; index++) {
    const toolCall = assistant.tool_calls[index]
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
 * Inner-dialog `(settled)`, malformed tool arguments, rejected tools, and
 * interrupted tool-call sequences are not outward speech. Sense transports
 * that need to replay the turn later (Voice/Twilio TTS, future meeting audio)
 * should use this helper instead of reading `assistant.content` directly.
 */
export function extractOutwardSenseDeliveryText(messages: ChatCompletionMessageParam[]): string | null {
  const assistantIndex = messages.findLastIndex((message) => message.role === "assistant")
  if (assistantIndex < 0) return null
  const assistant = messages[assistantIndex]
  return assistantContentText(assistant.content)
    ?? outwardDeliveryTextFromAssistantTools(messages, assistantIndex)
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
  /** The user's message text. */
  userMessage: string
  /** Optional transport delivery hook for outward `speak`/`settle` text. */
  deliverySink?: OutwardSenseDeliverySink
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
  let resolverParams: { provider: IdentityProvider; externalId: string; displayName: string; channel: string }
  if (isUuid) {
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

  // Initialize MCP manager so MCP tools appear as first-class tools in the agent's tool list
  const mcpManager = await getSharedMcpManager() ?? undefined

  // Session path and loading
  const sessionDir = path.join(agentRoot, "state", "sessions", friendId, channel)
  fs.mkdirSync(sessionDir, { recursive: true })
  const sessPath = path.join(sessionDir, `${sanitizeKey(sessionKey)}.json`)
  const existing = loadSession(sessPath)
  let sessionState = existing?.state
  let persistPromise: Promise<unknown> | undefined
  const sessionMessages: ChatCompletionMessageParam[] = existing?.messages && existing.messages.length > 0
    ? existing.messages
    : [{ role: "system", content: flattenSystemPrompt(await buildSystem(channel, {}, undefined)) }]

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
    try {
      await options.deliverySink?.onDelivery(delivery)
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

  /* v8 ignore start — no-op callback stubs; only onTextChunk does real work (covered via mock) */
  const callbacks: ChannelCallbacks = {
    onModelStart: () => {},
    onModelStreamStart: () => {},
    onTextChunk: (chunk: string) => { pendingResponseText += chunk },
    onReasoningChunk: () => {},
    onToolStart: () => {},
    onToolEnd: (name: string, _summary: string, success: boolean) => {
      if (name === "settle" && success) terminalDeliveryKind = "settle"
    },
    onError: () => {},
    onClearText: () => { pendingResponseText = "" },
    flushNow: () => deliverPending("speak", { throwOnError: true }),
  }
  /* v8 ignore stop */

  // Run the pipeline
  const userMsg: ChatCompletionMessageParam = { role: "user", content: userMessage }
  stampIngressTime(userMsg)
  await handleInboundTurn({
    channel,
    sessionKey,
    capabilities,
    messages: [userMsg],
    callbacks,
    /* v8 ignore start — delegation wrappers; pipeline integration tested separately */
    friendResolver: { resolve: () => resolver.resolve() },
    sessionLoader: {
      loadOrCreate: () => Promise.resolve({
        messages: sessionMessages,
        sessionPath: sessPath,
        state: sessionState,
        events: existing?.events,
      }),
    },
    /* v8 ignore stop */
    pendingDir,
    friendStore,
    provider: "local",
    externalId: friendId,
    enforceTrustGate,
    drainPending,
    runAgentOptions: { mcpManager },
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

  await deliverPending(terminalDeliveryKind, { throwOnError: false })

  const ponderDeferred = false

  // Build response
  let finalResponse: string
  if (committedResponseText.length === 0) {
    // Agent settled but no text came through callbacks — check session transcript for the settle answer
    // Await deferred persist so the session file is up-to-date before readback
    /* v8 ignore next -- persistPromise set inside v8-ignored postTurn callback; tested via pipeline integration @preserve */
    if (persistPromise) await persistPromise
    const postTurnSession = loadSession(sessPath)
    if (postTurnSession?.messages) {
      finalResponse = extractOutwardSenseDeliveryText(postTurnSession.messages)
        ?? "(agent responded but response was empty)"
    } else {
      finalResponse = "(agent responded but response was empty)"
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
  if (finalResponse.length === 0) {
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

  return { response: finalResponse, ponderDeferred, deliveries, deliveryFailures }
}
