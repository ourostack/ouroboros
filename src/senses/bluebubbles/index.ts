import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import OpenAI from "openai"
import { runAgent, type ChannelCallbacks, createSummarize } from "../../heart/core"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig, sessionPath } from "../../heart/config"
import { getAgentName, getAgentRoot } from "../../heart/identity"
import { recoverRuntimeCwd } from "../../heart/runtime-cwd"
import { withSharedTurnLock } from "../../heart/turn-coordinator"
import { loadSession, postTurnTrim, deferPostTurnPersist } from "../../mind/context"
import { accumulateFriendTokens } from "../../mind/friends/tokens"
import { upsertGroupContextParticipants } from "../../mind/friends/group-context"
import { FriendResolver, type FriendResolverParams } from "../../mind/friends/resolver"
import { FileFriendStore } from "../../mind/friends/store-file"
import { TRUSTED_LEVELS, type FriendRecord } from "../../mind/friends/types"
import { getChannelCapabilities } from "../../mind/friends/channel"
import { getPendingDir, drainDeferredReturns, drainPending } from "../../mind/pending"
import { buildSystem, flattenSystemPrompt } from "../../mind/prompt"
import { getSharedMcpManager } from "../../repertoire/mcp-manager"
import { emitNervesEvent } from "../../nerves/runtime"
import { getProactiveInternalContentBlockReason, emitProactiveInternalContentBlocked } from "../proactive-content-guard"
import type { BlueBubblesReplyTargetSelection } from "../../repertoire/tools-base"
import {
  BlueBubblesIgnoredEventError,
  normalizeBlueBubblesEvent,
  type BlueBubblesChatRef,
  type BlueBubblesNormalizedEvent,
  type BlueBubblesNormalizedMessage,
  type BlueBubblesNormalizedMutation,
} from "./model"
import { createBlueBubblesClient, type BlueBubblesClient } from "./client"
import {
  hasRecordedBlueBubblesInbound,
  listRecordedBlueBubblesInbound,
  recordBlueBubblesInbound,
  type BlueBubblesInboundSource,
} from "./inbound-log"
import { listBlueBubblesRecoveryCandidates, recordBlueBubblesMutation, type BlueBubblesMutationLogEntry } from "./mutation-log"
import { hasProcessedBlueBubblesMessage, hasProcessedBlueBubblesMessageGuid, recordProcessedBlueBubblesMessage } from "./processed-log"
import { readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState, type BlueBubblesRuntimeState } from "./runtime-state"
import { findObsoleteBlueBubblesThreadSessions } from "./session-cleanup"
import { createToolActivityCallbacks } from "../../heart/tool-activity-callbacks"
import { getDebugMode } from "../commands"
import { enforceTrustGate } from "../trust-gate"
import { handleInboundTurn, type FailoverState } from "../pipeline"

const bbFailoverStates = new Map<string, FailoverState>()
const bbInFlightMessageGuids = new Set<string>()

type BlueBubblesCallbacks = ChannelCallbacks & {
  flush(): Promise<void>
  finish(): Promise<void>
}

// Enrich reaction text with the original message content for context.
// If originalText is provided and non-empty, format as: baseText to: "truncated"
// Otherwise return baseText unchanged.
export function enrichReactionText(baseText: string, originalText: string | null, maxLen: number): string {
  if (!originalText) return baseText
  const truncated = originalText.length > maxLen
    ? originalText.slice(0, maxLen - 3) + "..."
    : originalText
  return `${baseText} to: "${truncated}"`
}

export interface StatusBatcher {
  add(text: string): void
  flush(): void
}

/**
 * Accumulates status descriptions and debounces them.
 * If multiple descriptions arrive within `delayMs`, they are joined with ` · `
 * and sent as a single message. Flush sends immediately and clears the timer.
 */
export function createStatusBatcher(send: (text: string) => void, delayMs: number): StatusBatcher {
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_status_batcher_created",
    message: "status batcher initialized",
    meta: { delayMs },
  })

  let pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  function fire(): void {
    if (pending.length === 0) return
    const combined = pending.join(" \u00b7 ")
    pending = []
    timer = null
    send(combined)
  }

  return {
    add(text: string): void {
      pending.push(text)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      fire()
    },
  }
}

export interface BlueBubblesHandleResult {
  handled: boolean
  notifiedAgent: boolean
  kind?: BlueBubblesNormalizedEvent["kind"]
  reason?: "from_me" | "mutation_state_only" | "already_processed" | "ignored"
}

function blueBubblesMessageKey(sessionKey: string, messageGuid: string): string {
  return `${sessionKey}:${messageGuid.trim()}`
}

function isBlueBubblesMessageInFlight(sessionKey: string, messageGuid: string): boolean {
  if (!messageGuid.trim()) return false
  return bbInFlightMessageGuids.has(blueBubblesMessageKey(sessionKey, messageGuid))
}

function beginBlueBubblesMessageInFlight(sessionKey: string, messageGuid: string): boolean {
  if (!messageGuid.trim()) return true
  const key = blueBubblesMessageKey(sessionKey, messageGuid)
  if (bbInFlightMessageGuids.has(key)) return false
  bbInFlightMessageGuids.add(key)
  return true
}

function endBlueBubblesMessageInFlight(sessionKey: string, messageGuid: string): void {
  bbInFlightMessageGuids.delete(blueBubblesMessageKey(sessionKey, messageGuid))
}

interface RuntimeDeps {
  getAgentName: typeof getAgentName
  buildSystem: typeof buildSystem
  runAgent: typeof runAgent
  loadSession: typeof loadSession
  postTurnTrim: typeof postTurnTrim
  deferPostTurnPersist: typeof deferPostTurnPersist
  sessionPath: typeof sessionPath
  accumulateFriendTokens: typeof accumulateFriendTokens
  createClient: () => BlueBubblesClient
  recordMutation: typeof recordBlueBubblesMutation
  createFriendStore: () => FileFriendStore
  createFriendResolver: (store: FileFriendStore, params: FriendResolverParams) => FriendResolver
  createServer: typeof http.createServer
  getOwnHandles: () => readonly string[]
}

export interface BlueBubblesReplyTargetController {
  getReplyToMessageGuid(): string | undefined
  setSelection(selection: BlueBubblesReplyTargetSelection): string
}

export interface ProactiveBlueBubblesSessionSendParams {
  friendId: string
  sessionKey: string
  text: string
  intent?: "generic_outreach" | "explicit_cross_chat"
  authorizingSession?: {
    friendId: string
    channel: string
    key: string
    trustLevel?: string
  }
}

export interface ProactiveBlueBubblesSessionSendResult {
  delivered: boolean
  reason?: "friend_not_found" | "trust_skip" | "missing_target" | "send_error" | "group_blocked" | "internal_content_blocked"
}

const defaultDeps: RuntimeDeps = {
  getAgentName,
  buildSystem,
  runAgent,
  loadSession,
  postTurnTrim,
  deferPostTurnPersist,
  sessionPath,
  accumulateFriendTokens,
  createClient: () => createBlueBubblesClient(),
  recordMutation: recordBlueBubblesMutation,
  createFriendStore: () => new FileFriendStore(path.join(getAgentRoot(), "friends")),
  createFriendResolver: (store, params) => new FriendResolver(store, params),
  createServer: http.createServer,
  getOwnHandles: () => [...getBlueBubblesConfig().ownHandles, ...discoveredOwnHandles],
}

const BLUEBUBBLES_RUNTIME_SYNC_INTERVAL_MS = 30_000
const BLUEBUBBLES_RECOVERY_PASS_DELAY_MS = 1_000
const BLUEBUBBLES_RECOVERY_PASS_INTERVAL_MS = 30_000
const BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS = 60_000
const BLUEBUBBLES_CATCHUP_PAGE_SIZE = 50
const BLUEBUBBLES_CATCHUP_MAX_PAGES = 20
const BLUEBUBBLES_HEALTHY_CATCHUP_OVERLAP_MS = 90_000
const BLUEBUBBLES_RECOVERY_CATCHUP_LOOKBACK_MS = 24 * 60 * 60 * 1000
const BLUEBUBBLES_FIRST_CATCHUP_LOOKBACK_MS = 10 * 60 * 1000

interface BlueBubblesHandleOptions {
  timeoutMs?: number
}

class BlueBubblesRecoveryTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`bluebubbles recovery turn timed out after ${timeoutMs}ms`)
    this.name = "BlueBubblesRecoveryTurnTimeoutError"
  }
}

function isBlueBubblesRecoveryTurnTimeoutError(error: unknown): boolean {
  return error instanceof BlueBubblesRecoveryTurnTimeoutError
    || (error instanceof Error && error.name === "BlueBubblesRecoveryTurnTimeoutError")
}

function resolveFriendParams(event: BlueBubblesNormalizedEvent): FriendResolverParams {
  if (event.chat.isGroup) {
    const groupKey = event.chat.chatGuid ?? event.chat.chatIdentifier ?? event.sender.externalId
    return {
      provider: "imessage-handle",
      externalId: `group:${groupKey}`,
      displayName: event.chat.displayName ?? "Unknown Group",
      channel: "bluebubbles",
    }
  }

  return {
    provider: "imessage-handle",
    externalId: event.sender.externalId || event.sender.rawId,
    displayName: event.sender.displayName || "Unknown",
    channel: "bluebubbles",
  }
}

function resolveGroupExternalId(event: BlueBubblesNormalizedEvent): string {
  const groupKey = event.chat.chatGuid ?? event.chat.chatIdentifier ?? event.sender.externalId
  return `group:${groupKey}`
}

/**
 * Check if any participant in a group chat is a known family member.
 * Looks up each participant handle in the friend store.
 */
async function checkGroupHasFamilyMember(
  store: FileFriendStore,
  event: BlueBubblesNormalizedEvent,
): Promise<boolean> {
  if (!event.chat.isGroup) return false
  for (const handle of event.chat.participantHandles ?? []) {
    const friend = await store.findByExternalId("imessage-handle", handle)
    if (friend?.trustLevel === "family") return true
  }
  return false
}

/**
 * Check if an acquaintance shares any group chat with a family member.
 * Compares group-prefixed externalIds between the acquaintance and all family members.
 */
async function checkHasExistingGroupWithFamily(
  store: FileFriendStore,
  senderFriend: FriendRecord,
): Promise<boolean> {
  const trustLevel = senderFriend.trustLevel ?? "friend"
  if (trustLevel !== "acquaintance") return false

  const acquaintanceGroups = new Set(
    (senderFriend.externalIds ?? [])
      .filter((eid) => eid.externalId.startsWith("group:"))
      .map((eid) => eid.externalId),
  )
  if (acquaintanceGroups.size === 0) return false

  const allFriends = await (store.listAll?.() ?? Promise.resolve([]))
  for (const friend of allFriends) {
    if (friend.trustLevel !== "family") continue
    const friendGroups = (friend.externalIds ?? [])
      .filter((eid) => eid.externalId.startsWith("group:"))
      .map((eid) => eid.externalId)
    for (const group of friendGroups) {
      if (acquaintanceGroups.has(group)) return true
    }
  }
  return false
}

function extractMessageText(content: OpenAI.ChatCompletionMessageParam["content"] | undefined): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
        return part.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

type HistoricalLaneSummary = {
  label: string
  key: string
  snippet: string
}

function isHistoricalLaneMetadataLine(line: string): boolean {
  return /^\[(conversation scope|recent active lanes|routing control):?/i.test(line)
    || /^- (top_level|thread:[^:]+):/i.test(line)
}

function extractHistoricalLaneSummary(
  messages: OpenAI.ChatCompletionMessageParam[],
): HistoricalLaneSummary[] {
  const seen = new Set<string>()
  const summaries: HistoricalLaneSummary[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "user") continue
    const text = extractMessageText(message.content)
    if (!text) continue
    const firstLine = text.split("\n")[0].trim()
    const threadMatch = firstLine.match(/thread id: ([^\]|]+)/i)
    const laneKey = threadMatch
      ? `thread:${threadMatch[1].trim()}`
      : /top[-_]level/i.test(firstLine)
        ? "top_level"
        : null
    if (!laneKey || seen.has(laneKey)) continue
    seen.add(laneKey)
    const snippet = text
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !isHistoricalLaneMetadataLine(line))
      ?.slice(0, 80) ?? "(no recent text)"
    summaries.push({
      key: laneKey,
      label: laneKey === "top_level" ? "top_level" : laneKey,
      snippet,
    })
    if (summaries.length >= 5) break
  }
  return summaries
}

function buildConversationScopePrefix(
  event: BlueBubblesNormalizedEvent,
  existingMessages: OpenAI.ChatCompletionMessageParam[],
  repliedToText?: string | null,
): string {
  if (event.kind !== "message") {
    return ""
  }

  const summaries = extractHistoricalLaneSummary(existingMessages)
  const lines: string[] = []
  if (event.threadOriginatorGuid?.trim()) {
    lines.push(
      `[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: ${event.threadOriginatorGuid.trim()} | default outbound target for this turn: current_lane]`,
    )
    if (repliedToText) {
      lines.push(`[replying to: "${repliedToText}"]`)
    }
      lines.push(`[if you need more context about what was being discussed, use query_session to search your session history, or search_notes to search diary/journal notes.]`)
  } else {
    lines.push(
      "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]",
    )
  }
  if (summaries.length > 0) {
    lines.push("[recent active lanes]")
    for (const summary of summaries) {
      lines.push(`- ${summary.label}: ${summary.snippet}`)
    }
  }
  if (event.threadOriginatorGuid?.trim() || summaries.some((summary) => summary.key.startsWith("thread:"))) {
    lines.push(
      "[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]",
    )
  }
  return lines.join("\n")
}

function buildInboundText(
  event: BlueBubblesNormalizedEvent,
  existingMessages: OpenAI.ChatCompletionMessageParam[],
  repliedToText?: string | null,
): string {
  const metadataPrefix = buildConversationScopePrefix(event, existingMessages, repliedToText)
  const baseText = event.repairNotice?.trim()
    ? `${event.textForAgent}\n[${event.repairNotice.trim()}]`
    : event.textForAgent
  if (!event.chat.isGroup) {
    return metadataPrefix ? `${metadataPrefix}\n${baseText}` : baseText
  }
  const scopedText = metadataPrefix ? `${metadataPrefix}\n${baseText}` : baseText
  if (event.kind === "mutation") {
    return `${event.sender.displayName} ${scopedText}`
  }
  return `${event.sender.displayName}: ${scopedText}`
}

function buildInboundContent(
  event: BlueBubblesNormalizedEvent,
  existingMessages: OpenAI.ChatCompletionMessageParam[],
  repliedToText?: string | null,
): OpenAI.ChatCompletionUserMessageParam["content"] {
  const text = buildInboundText(event, existingMessages, repliedToText)
  if (event.kind !== "message" || !event.inputPartsForAgent || event.inputPartsForAgent.length === 0) {
    return text
  }

  return [
    { type: "text", text },
    ...event.inputPartsForAgent,
  ]
}

function sessionLikelyContainsMessage(
  event: BlueBubblesNormalizedMessage,
  existingMessages: OpenAI.ChatCompletionMessageParam[],
): boolean {
  const fragment = event.textForAgent.trim()
  if (!fragment) return false
  return existingMessages.some((message) => {
    if (message.role !== "user") return false
    return extractMessageText(message.content).includes(fragment)
  })
}

function mutationEntryToEvent(entry: BlueBubblesMutationLogEntry): BlueBubblesNormalizedMutation {
  return {
    kind: "mutation",
    eventType: entry.eventType,
    mutationType: entry.mutationType as BlueBubblesNormalizedMutation["mutationType"],
    messageGuid: entry.messageGuid,
    targetMessageGuid: entry.targetMessageGuid ?? undefined,
    timestamp: Date.parse(entry.recordedAt) || Date.now(),
    fromMe: entry.fromMe,
    sender: {
      provider: "imessage-handle",
      externalId: entry.chatIdentifier ?? entry.chatGuid ?? "unknown",
      rawId: entry.chatIdentifier ?? entry.chatGuid ?? "unknown",
      displayName: entry.chatIdentifier ?? entry.chatGuid ?? "Unknown",
    },
    chat: {
      chatGuid: entry.chatGuid ?? undefined,
      chatIdentifier: entry.chatIdentifier ?? undefined,
      displayName: undefined,
      isGroup: Boolean(entry.chatGuid?.includes(";+;")),
      sessionKey: entry.sessionKey,
      sendTarget: entry.chatGuid
        ? { kind: "chat_guid", value: entry.chatGuid }
        : { kind: "chat_identifier", value: entry.chatIdentifier ?? "unknown" },
      participantHandles: [],
    },
    shouldNotifyAgent: entry.shouldNotifyAgent,
    textForAgent: entry.textForAgent,
    requiresRepair: true,
  }
}

function getBlueBubblesContinuityIngressTexts(event: BlueBubblesNormalizedEvent): string[] {
  if (event.kind !== "message") return []

  const text = event.textForAgent.trim()
  if (text.length > 0) return [text]

  const fallbackText = (event.inputPartsForAgent ?? [])
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text.trim()
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")

  return fallbackText ? [fallbackText] : []
}

function createReplyTargetController(event: BlueBubblesNormalizedEvent): BlueBubblesReplyTargetController {
  const defaultTargetLabel = event.kind === "message" && event.threadOriginatorGuid?.trim() ? "current_lane" : "top_level"
  let selection: BlueBubblesReplyTargetSelection =
    event.kind === "message" && event.threadOriginatorGuid?.trim()
      ? { target: "current_lane" }
      : { target: "top_level" }

  return {
    getReplyToMessageGuid(): string | undefined {
      if (event.kind !== "message") return undefined
      if (selection.target === "top_level") return undefined
      if (selection.target === "thread") return selection.threadOriginatorGuid.trim()
      return event.threadOriginatorGuid?.trim() ? event.messageGuid : undefined
    },
    setSelection(next: BlueBubblesReplyTargetSelection): string {
      selection = next
      if (next.target === "top_level") {
        return "bluebubbles reply target override: top_level"
      }
      if (next.target === "thread") {
        return `bluebubbles reply target override: thread:${next.threadOriginatorGuid}`
      }
      return `bluebubbles reply target: using default for this turn (${defaultTargetLabel})`
    },
  }
}

function emitBlueBubblesMarkReadWarning(chat: BlueBubblesChatRef, error: unknown): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_mark_read_error",
    message: "failed to mark bluebubbles chat as read",
    meta: {
      chatGuid: chat.chatGuid ?? null,
      reason: error instanceof Error ? error.message : String(error),
    },
  })
}

export function createBlueBubblesCallbacks(
  client: BlueBubblesClient,
  chat: BlueBubblesChatRef,
  replyTarget: BlueBubblesReplyTargetController,
  isGroupChat: boolean,
): BlueBubblesCallbacks {
  let textBuffer = ""
  let typingActive = false
  let queue = Promise.resolve()

  function enqueue(operation: string, task: () => Promise<void>): void {
    queue = queue.then(task).catch((error) => {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_activity_error",
        message: "bluebubbles activity transport failed",
        meta: { operation, reason: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  function startTypingNow(): void {
    /* v8 ignore next -- defensive guard: callers already check typingActive @preserve */
    if (typingActive) return
    typingActive = true
    enqueue("typing_start", async () => {
      const [markReadResult, typingResult] = await Promise.allSettled([
        client.markChatRead(chat),
        client.setTyping(chat, true),
      ])
      if (markReadResult.status === "rejected") {
        emitBlueBubblesMarkReadWarning(chat, markReadResult.reason)
      }
      if (typingResult.status === "rejected") {
        throw typingResult.reason
      }
    })
  }

  function sendStatus(text: string): void {
    enqueue("send_status", async () => {
      await client.sendText({
        chat,
        text,
        replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
      })
      // Re-enable typing indicator — sending a message clears the typing bubble
      await client.setTyping(chat, true)
    })
  }

  const statusBatcher = createStatusBatcher((text) => sendStatus(text), 500)

  const toolCallbacks = createToolActivityCallbacks({
    onDescription: (text) => statusBatcher.add(text),
    /* v8 ignore next -- onResult only called in debug mode; tested via tool-activity-callbacks.test.ts @preserve */
    onResult: (text) => { statusBatcher.flush(); sendStatus(text) },
    /* v8 ignore next -- onFailure only called on tool failure; tested via tool-activity-callbacks.test.ts @preserve */
    onFailure: (text) => { statusBatcher.flush(); sendStatus(text) },
    isDebug: getDebugMode,
  })

  return {
    onModelStart(): void {
      if (!isGroupChat) startTypingNow()
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_turn_start",
        message: "bluebubbles turn started",
        meta: { chatGuid: chat.chatGuid ?? null },
      })
    },

    onModelStreamStart(): void {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_stream_start",
        message: "bluebubbles non-streaming response started",
        meta: {},
      })
    },

    onTextChunk(text: string): void {
      if (isGroupChat && !typingActive) startTypingNow()
      textBuffer += text
    },

    onReasoningChunk(_text: string): void {},

    onToolStart(name: string, _args: Record<string, string>): void {
      // observe + speak are flow-control: their visible output (or lack of it) is
      // handled outside the tool-activity callbacks. speak in particular delivers
      // its message via onTextChunk/flushNow — we MUST NOT enqueue a "speaking..."
      // status sendText here, which would arrive as a separate iMessage right
      // before the actual speak content.
      if (name === "observe" || name === "speak") {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_tool_start",
          message: "bluebubbles tool execution started",
          meta: { name },
        })
        return
      }

      // Tool activity is a reply commitment — start typing if not already
      if (!typingActive) startTypingNow()
      toolCallbacks.onToolStart(name, _args)
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_tool_start",
        message: "bluebubbles tool execution started",
        meta: { name },
      })
    },

    onToolEnd(name: string, summary: string, success: boolean): void {
      // observe + speak skip the tool-activity end callback (no ✓/✗ status sent).
      if (name !== "observe" && name !== "speak") {
        toolCallbacks.onToolEnd(name, summary, success)
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_tool_end",
        message: "bluebubbles tool execution completed",
        meta: { name, success, summary },
      })
    },

    onError(error: Error, severity: "transient" | "terminal"): void {
      sendStatus(`\u2717 ${error.message}`)
      emitNervesEvent({
        level: severity === "terminal" ? "error" : "warn",
        component: "senses",
        event: "senses.bluebubbles_turn_error",
        message: "bluebubbles turn callback error",
        meta: { severity, reason: error.message },
      })
    },

    onClearText(): void {
      textBuffer = ""
    },

    async flushNow(): Promise<void> {
      // Contract: throws if delivery fails. We deliberately let `client.sendText`
      // rejections propagate so the engine's speak interception can mark the
      // tool call as failed and tell the agent the message did not reach the
      // friend (rather than silently logging and pretending success).
      const trimmed = textBuffer.trim()
      if (!trimmed) return
      textBuffer = ""
      await client.sendText({
        chat,
        text: trimmed,
        replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
      })
      // Note: do NOT call client.setTyping(chat, false) here — the agent is
      // still mid-turn, so the typing indicator stays ACTIVE.
      emitNervesEvent({
        component: "senses",
        event: "bluebubbles.speak_flush",
        message: "bluebubbles flushed mid-turn speak",
        meta: { messageLength: trimmed.length },
      })
    },

    async flush(): Promise<void> {
      statusBatcher.flush()
      await queue
      const trimmed = textBuffer.trim()
      if (!trimmed) {
        if (typingActive) {
          typingActive = false
          enqueue("typing_stop", async () => { await client.setTyping(chat, false) })
          await queue
        }
        return
      }
      textBuffer = ""
      /* v8 ignore next 4 -- branch: typing may already be stopped before flush @preserve */
      if (typingActive) {
        typingActive = false
        enqueue("typing_stop", async () => { await client.setTyping(chat, false) })
        await queue
      }
      await client.sendText({
        chat,
        text: trimmed,
        replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
      })
    },

    async finish(): Promise<void> {
      statusBatcher.flush()
      if (!typingActive) {
        await queue
        return
      }
      typingActive = false
      enqueue("typing_stop", async () => { await client.setTyping(chat, false) })
      await queue
    },
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of req) {
    body += chunk.toString()
  }
  return body
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(payload))
}

function isWebhookPasswordValid(url: URL, expectedPassword: string): boolean {
  const provided = url.searchParams.get("password")
  return !provided || provided === expectedPassword
}

function normalizeHandleForSelfMatch(handle: string): string {
  const trimmed = handle.trim().toLowerCase()
  if (!trimmed) return ""
  // Phone-shaped: strip everything but digits so +1 (415) 555-... matches 14155550000.
  if (/[+\d]/.test(trimmed) && !trimmed.includes("@")) {
    const digits = trimmed.replace(/\D/g, "")
    if (digits.length >= 7) return digits
  }
  return trimmed
}

export function isAgentSelfHandle(senderExternalId: string | undefined, ownHandles: readonly string[]): boolean {
  if (!senderExternalId || !senderExternalId.trim()) return false
  const target = normalizeHandleForSelfMatch(senderExternalId)
  /* v8 ignore start -- target is non-empty by construction since senderExternalId was just verified non-whitespace */
  if (!target) return false
  /* v8 ignore stop */
  for (const own of ownHandles) {
    if (normalizeHandleForSelfMatch(own) === target) return true
  }
  return false
}

/**
 * In-memory store of agent iMessage handles auto-discovered from group-chat
 * `event.fromMe === true` events. Bluebubbles can attribute the peer's handle
 * as `event.sender.externalId` on 1:1 outbound messages, so discovery is
 * intentionally limited to the group echo bug that motivated
 * `bluebubbles.ownHandles` originally.
 *
 * Per-process. A daemon restart re-learns from the next outbound. The
 * accompanying nerves event (`senses.bluebubbles_own_handle_discovered`)
 * tells the operator what to add to `bluebubbles.ownHandles` for cross-
 * restart durability.
 */
const discoveredOwnHandles = new Set<string>()

export function getDiscoveredOwnHandles(): readonly string[] {
  return [...discoveredOwnHandles]
}

export function clearDiscoveredOwnHandles(): void {
  discoveredOwnHandles.clear()
}

export function recordDiscoveredOwnHandle(senderExternalId: string | undefined): boolean {
  if (!senderExternalId || !senderExternalId.trim()) return false
  const trimmed = senderExternalId.trim()
  const normalized = normalizeHandleForSelfMatch(trimmed)
  /* v8 ignore next -- defensive: normalizeHandleForSelfMatch only returns falsy for empty input, already guarded above @preserve */
  if (!normalized) return false
  for (const existing of discoveredOwnHandles) {
    if (normalizeHandleForSelfMatch(existing) === normalized) return false
  }
  discoveredOwnHandles.add(trimmed)
  emitNervesEvent({
    level: "info",
    component: "senses",
    event: "senses.bluebubbles_own_handle_discovered",
    message: "captured a new agent-owned bluebubbles handle from an isFromMe outbound — add to bluebubbles.ownHandles for cross-restart durability",
    meta: { handle: trimmed, totalDiscovered: discoveredOwnHandles.size },
  })
  return true
}

function isSelfFriendRecord(friend: FriendRecord | null, agentName: string): boolean {
  if (!friend || friend.kind !== "agent") return false
  const normalizedAgent = agentName.trim().toLowerCase()
  const name = friend.name?.trim().toLowerCase()
  const bundleName = friend.agentMeta?.bundleName?.trim().toLowerCase()
  return name === normalizedAgent || bundleName === normalizedAgent
}

async function shouldFilterAgentSelfHandle(
  event: BlueBubblesNormalizedEvent,
  resolvedDeps: RuntimeDeps,
): Promise<boolean> {
  if (!event.chat.isGroup) return false
  if (!isAgentSelfHandle(event.sender.externalId, resolvedDeps.getOwnHandles())) return false

  const store = resolvedDeps.createFriendStore()
  const knownFriend = await store
    .findByExternalId("imessage-handle", event.sender.externalId)
    .catch(() => null)

  if (knownFriend && !isSelfFriendRecord(knownFriend, resolvedDeps.getAgentName())) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_self_handle_bypassed_known_friend",
      message: "did not filter bluebubbles sender even though it matched ownHandles because it resolves to a known non-self friend",
      meta: {
        messageGuid: event.messageGuid,
        kind: event.kind,
        senderExternalId: event.sender.externalId,
        friendId: knownFriend.id,
      },
    })
    return false
  }

  return true
}

async function handleBlueBubblesNormalizedEvent(
  event: BlueBubblesNormalizedEvent,
  resolvedDeps: RuntimeDeps,
  source: BlueBubblesInboundSource,
  options: BlueBubblesHandleOptions = {},
): Promise<BlueBubblesHandleResult> {
  const client = resolvedDeps.createClient()
  const agentName = resolvedDeps.getAgentName()
  recoverRuntimeCwd()
  if (event.fromMe) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_from_me_ignored",
      message: "ignored from-me bluebubbles event",
      meta: {
        messageGuid: event.messageGuid,
        kind: event.kind,
      },
    })
    if (event.chat.isGroup) recordDiscoveredOwnHandle(event.sender.externalId)
    return { handled: true, notifiedAgent: false, kind: event.kind, reason: "from_me" }
  }
  // Fallback self-detection: BlueBubbles sometimes broadcasts a group-chat
  // outbound message back through the webhook with `isFromMe` missing/false.
  // Without this guard the agent ingests its own message and replies to it
  // ("Slugger talking to himself"). Compare the sender's externalId against
  // the agent's known iMessage handles. Keep this group-only: 1:1 outbound
  // echoes can be attributed to the peer handle, and stale ownHandles entries
  // must not make real DMs disappear.
  if (await shouldFilterAgentSelfHandle(event, resolvedDeps)) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_self_handle_filtered",
      message: "filtered bluebubbles event whose sender matched an agent-owned handle (isFromMe was missing/false)",
      meta: {
        messageGuid: event.messageGuid,
        kind: event.kind,
        senderExternalId: event.sender.externalId,
      },
    })
    return { handled: true, notifiedAgent: false, kind: event.kind, reason: "from_me" }
  }

  if (event.kind === "mutation") {
    try {
      resolvedDeps.recordMutation(resolvedDeps.getAgentName(), event)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_mutation_log_error",
        message: "failed recording bluebubbles mutation sidecar",
        meta: {
          messageGuid: event.messageGuid,
          mutationType: event.mutationType,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  if (event.kind === "mutation" && !event.shouldNotifyAgent) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_state_mutation_recorded",
      message: "recorded non-notify bluebubbles mutation",
      meta: {
        messageGuid: event.messageGuid,
        mutationType: event.mutationType,
      },
    })
    return { handled: true, notifiedAgent: false, kind: event.kind, reason: "mutation_state_only" }
  }

  let ownsInFlightMessage = false
  if (event.kind === "message") {
    if (
      hasProcessedBlueBubblesMessage(agentName, event.chat.sessionKey, event.messageGuid)
      || hasProcessedBlueBubblesMessageGuid(agentName, event.messageGuid)
    ) {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_recovery_skip",
        message: "skipped bluebubbles message already marked as handled",
        meta: {
          messageGuid: event.messageGuid,
          sessionKey: event.chat.sessionKey,
          source,
          dedupeReason: "processed",
        },
      })
      return { handled: true, notifiedAgent: false, kind: event.kind, reason: "already_processed" }
    }
    if (!beginBlueBubblesMessageInFlight(event.chat.sessionKey, event.messageGuid)) {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_recovery_skip",
        message: "skipped bluebubbles message already in flight",
        meta: {
          messageGuid: event.messageGuid,
          sessionKey: event.chat.sessionKey,
          source,
          dedupeReason: "in_flight",
        },
      })
      return { handled: true, notifiedAgent: false, kind: event.kind, reason: "already_processed" }
    }
    ownsInFlightMessage = true
  }

  try {
    // ── Adapter setup: friend, session, content, callbacks ──────────

    const store = resolvedDeps.createFriendStore()
    const resolver = resolvedDeps.createFriendResolver(store, resolveFriendParams(event))
    const baseContext = await resolver.resolve()
    const context = { ...baseContext, isGroupChat: event.chat.isGroup }
    const replyTarget = createReplyTargetController(event)

    const friendId = context.friend.id
    const sessPath = resolvedDeps.sessionPath(friendId, "bluebubbles", event.chat.sessionKey)
    try {
      findObsoleteBlueBubblesThreadSessions(sessPath)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_thread_lane_cleanup_error",
        message: "failed to inspect obsolete bluebubbles thread-lane sessions",
        meta: {
          sessionPath: sessPath,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }

    return await withSharedTurnLock("bluebubbles", sessPath, async () => {
    // Pre-load session inside the turn lock so same-chat deliveries cannot race on stale trunk state.
    const existing = resolvedDeps.loadSession(sessPath)
    const mcpManager = await getSharedMcpManager() ?? undefined
    const sessionMessages: OpenAI.ChatCompletionMessageParam[] =
      existing?.messages && existing.messages.length > 0
        ? existing.messages
        : [{ role: "system", content: flattenSystemPrompt(await resolvedDeps.buildSystem("bluebubbles", {}, context)) }]

    if (event.kind === "message") {
      // Record EARLY for audit and crash recovery. This is capture truth, not
      // a claim that the agent turn completed successfully.
      const inboundSource: BlueBubblesInboundSource =
        source !== "webhook" && sessionLikelyContainsMessage(event, existing?.messages ?? sessionMessages)
          ? "recovery-bootstrap"
          : source
      recordBlueBubblesInbound(agentName, event, inboundSource)

      if (inboundSource === "recovery-bootstrap") {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_recovery_skip",
          message: "skipped bluebubbles recovery because the session already contains the message text",
          meta: {
            messageGuid: event.messageGuid,
            sessionKey: event.chat.sessionKey,
            source,
          },
        })
        recordProcessedBlueBubblesMessage(agentName, event, inboundSource, "session-bootstrap")
        return { handled: true, notifiedAgent: false, kind: event.kind, reason: "already_processed" }
      }
    }

    if (event.kind === "message" && event.chat.isGroup) {
      await upsertGroupContextParticipants({
        store,
        participants: (event.chat.participantHandles ?? []).map((externalId) => ({
          provider: "imessage-handle" as const,
          externalId,
        })),
        groupExternalId: resolveGroupExternalId(event),
      })
    }

    // Fetch the text of the message being replied to (if this is a threaded reply)
    const threadGuid = event.kind === "message" ? event.threadOriginatorGuid?.trim() : undefined
    let repliedToText: string | null = null
    if (threadGuid) {
      repliedToText = await client.getMessageText(threadGuid).catch(/* v8 ignore next */ () => null)
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_reply_context",
        message: repliedToText ? "fetched replied-to message text" : "could not fetch replied-to message text",
        meta: { threadGuid, hasText: !!repliedToText },
      })
    }

    // Enrich reaction mutations with the original message text for context
    const isReaction = event.kind === "mutation" && event.mutationType === "reaction"
    if (isReaction && event.targetMessageGuid) {
      /* v8 ignore start -- best-effort lookup; enrichReactionText covered by unit tests @preserve */
      const originalText = await client.getMessageText(event.targetMessageGuid).catch(() => null)
      if (originalText) event.textForAgent = enrichReactionText(event.textForAgent, originalText, 80)
      /* v8 ignore stop */
    }

    // Build inbound user message (adapter concern: BB-specific content formatting)
    const userMessage: OpenAI.ChatCompletionMessageParam = {
      role: "user",
      content: buildInboundContent(event, existing?.messages ?? sessionMessages, repliedToText),
    }

    const callbacks = createBlueBubblesCallbacks(
      client,
      event.chat,
      replyTarget,
      event.chat.isGroup,
    )
    const controller = new AbortController()
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutPromise: Promise<never> | null = null
    let timeoutReject: ((error: Error) => void) | undefined
    let recoveryTimedOut = false

    // BB-specific tool context wrappers
    const summarize = createSummarize("human")

    const bbCapabilities = getChannelCapabilities("bluebubbles")
    const pendingDir = getPendingDir(resolvedDeps.getAgentName(), friendId, "bluebubbles", event.chat.sessionKey)

    // ── Compute trust gate context for group/acquaintance rules ─────
    const groupHasFamilyMember = await checkGroupHasFamilyMember(store, event)
    const hasExistingGroupWithFamily = event.chat.isGroup
      ? false
      : await checkHasExistingGroupWithFamily(store, context.friend)

    // ── Call shared pipeline ──────────────────────────────────────────

    // Buffer terminal errors so failover can suppress them.
    // If failover produces a message, the buffered error is skipped.
    // If failover doesn't fire, the buffered error is replayed.
    let bufferedTerminalError: Error | null = null
    /* v8 ignore start -- failover-aware error buffering @preserve */
    const failoverAwareCallbacks: typeof callbacks = {
      ...callbacks,
      onError(error: Error, severity: "transient" | "terminal"): void {
        if (severity === "terminal") {
          bufferedTerminalError = error
          return
        }
        callbacks.onError(error, severity)
      },
    }
    /* v8 ignore stop */

    try {
      const timeoutMs = options.timeoutMs
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutPromise = new Promise<never>((_, reject) => {
          timeoutReject = reject
        })
        timeoutTimer = setTimeout(() => {
          const reason = new BlueBubblesRecoveryTurnTimeoutError(timeoutMs)
          recoveryTimedOut = true
          controller.abort(reason)
          timeoutReject?.(reason)
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_turn_timeout",
            message: "bluebubbles recovery turn timed out",
            meta: {
              messageGuid: event.messageGuid,
              sessionKey: event.chat.sessionKey,
              source,
              timeoutMs,
            },
          })
        }, timeoutMs)
        /* v8 ignore next -- timer handles expose unref only in some runtimes @preserve */
        if (typeof (timeoutTimer as { unref?: () => void }).unref === "function") {
          (timeoutTimer as { unref: () => void }).unref()
        }
      }

      const turnPromise = handleInboundTurn({
        channel: "bluebubbles",
        sessionKey: event.chat.sessionKey,
        capabilities: bbCapabilities,
        messages: [userMessage],
        continuityIngressTexts: getBlueBubblesContinuityIngressTexts(event),
        friendResolver: { resolve: () => Promise.resolve(context) },
        sessionLoader: {
          loadOrCreate: () => Promise.resolve({
            messages: sessionMessages,
            sessionPath: sessPath,
            state: existing?.state,
            events: existing?.events,
          }),
        },
        pendingDir,
        friendStore: store,
        provider: "imessage-handle",
        externalId: event.sender.externalId || event.sender.rawId,
        isGroupChat: event.chat.isGroup,
        groupHasFamilyMember,
        hasExistingGroupWithFamily,
        enforceTrustGate,
        drainPending,
        drainDeferredReturns: (deferredFriendId) => drainDeferredReturns(resolvedDeps.getAgentName(), deferredFriendId),
        runAgent: (msgs, cb, channel, sig, opts) => resolvedDeps.runAgent(msgs, cb, channel, sig, {
          ...opts,
          toolContext: {
            /* v8 ignore next -- default no-op signin; pipeline provides the real one @preserve */
            signin: async () => undefined,
            ...opts?.toolContext,
            summarize,
            bluebubblesReplyTarget: {
              setSelection: (selection: BlueBubblesReplyTargetSelection) => replyTarget.setSelection(selection),
            },
            codingFeedback: {
              send: async (message: string) => {
                await client.sendText({
                  chat: event.chat,
                  text: message,
                  replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
                })
              },
            },
          },
        }),
        postTurn: (turnMessages, sessionPathArg, usage, hooks, state) => {
          const prepared = resolvedDeps.postTurnTrim(turnMessages, usage, hooks)
          resolvedDeps.deferPostTurnPersist(sessionPathArg, prepared, usage, state)
        },
        accumulateFriendTokens: resolvedDeps.accumulateFriendTokens,
        signal: controller.signal,
        runAgentOptions: { mcpManager, ...(isReaction ? { isReactionSignal: true } : {}) },
        callbacks: failoverAwareCallbacks,
        failoverState: (() => {
          if (!bbFailoverStates.has(event.chat.sessionKey)) {
            bbFailoverStates.set(event.chat.sessionKey, { pending: null })
          }
          return bbFailoverStates.get(event.chat.sessionKey)!
        })(),
      })
      /* v8 ignore start -- detached late-rejection telemetry is asserted in timeout tests, but V8 does not reliably attribute Promise.catch callbacks @preserve */
      if (timeoutPromise) {
        void turnPromise.catch((error) => {
          if (!recoveryTimedOut) return
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_recovery_error",
            message: "bluebubbles recovery turn rejected after timeout",
            meta: {
              messageGuid: event.messageGuid,
              sessionKey: event.chat.sessionKey,
              source,
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        })
      }
      /* v8 ignore stop */
      const result = timeoutPromise
        ? await Promise.race([turnPromise, timeoutPromise])
        : await turnPromise

      /* v8 ignore start -- failover display + error replay @preserve */
      if (result.failoverMessage) {
        // Failover handled it — show the failover message, skip the buffered error
        await client.sendText({ chat: event.chat, text: result.failoverMessage })
      } else if (bufferedTerminalError) {
        // No failover — replay the buffered terminal error
        callbacks.onError(bufferedTerminalError, "terminal")
      }
      /* v8 ignore stop */

      // ── Handle gate result ────────────────────────────────────────

      if (!result.gateResult.allowed) {
        // Send auto-reply via BB API if the gate provides one
        if ("autoReply" in result.gateResult && result.gateResult.autoReply) {
          await client.sendText({
            chat: event.chat,
            text: result.gateResult.autoReply,
          })
        }
        if (event.kind === "message") {
          recordProcessedBlueBubblesMessage(agentName, event, source, "trust-gated")
        }

        return {
          handled: true,
          notifiedAgent: false,
          kind: event.kind,
        }
      }

      // Gate allowed — flush the agent's reply
      await callbacks.flush()
      if (event.kind === "message") {
        recordProcessedBlueBubblesMessage(agentName, event, source, "turn-complete")
      }

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_turn_end",
        message: "bluebubbles event handled",
        meta: {
          messageGuid: event.messageGuid,
          kind: event.kind,
          sessionKey: event.chat.sessionKey,
        },
      })

      return {
        handled: true,
        notifiedAgent: true,
        kind: event.kind,
      }
    } finally {
      // If a terminal error was buffered and never replayed (e.g., handleInboundTurn threw),
      // replay it now so the user still sees the error.
      /* v8 ignore start -- error replay on throw: tested via BB error test @preserve */
      if (bufferedTerminalError) {
        callbacks.onError(bufferedTerminalError, "terminal")
        bufferedTerminalError = null
      }
      /* v8 ignore stop */
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      await callbacks.finish()
    }
    })
  } finally {
    if (ownsInFlightMessage && event.kind === "message") {
      endBlueBubblesMessageInFlight(event.chat.sessionKey, event.messageGuid)
    }
  }
}

export async function handleBlueBubblesEvent(
  payload: unknown,
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesHandleResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const client = resolvedDeps.createClient()
  let normalized: BlueBubblesNormalizedEvent
  try {
    normalized = normalizeBlueBubblesEvent(payload)
  } catch (error) {
    if (error instanceof BlueBubblesIgnoredEventError) {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_event_skipped",
        message: "skipped ignorable bluebubbles event",
        meta: {
          eventType: error.eventType,
        },
      })
      return {
        handled: true,
        notifiedAgent: false,
        reason: "ignored",
      }
    }
    throw error
  }
  // Pre-repair dedup: if we've already processed this messageGuid, skip the
  // repair+hydrate path entirely. Applies to BOTH `kind: "message"` AND
  // `kind: "mutation"` events — BlueBubbles often sends a `new-message`
  // webhook for a fresh message AND one or more follow-up `updated-message`
  // webhooks for delivery/read status. The mutation path (inside repairEvent)
  // can promote an updated-message back to a message if it has recoverable
  // content, which then re-runs the full VLM-describe pipeline on the same
  // attachment.
  //
  // Without this early check, we paid DOUBLE latency and double tokens on
  // every image-bearing message. Verified live on 2026-04-08T00:58Z: two
  // sequential VLM describes for attachment guid 317E37EB-..., 13.7s +
  // 14.0s each, for the exact same 291KB JPEG — triggered by a sequence of
  // `new-message` followed ~3s later by `updated-message` for the same guid.
  //
  // We still route the skip through `handleBlueBubblesNormalizedEvent` so
  // the downstream `already_processed` path fires its observability events
  // and the caller sees a consistent return shape.
  const agentName = resolvedDeps.getAgentName()
  // normalizeBlueBubblesEvent rejects guidless payloads, so duplicate handling
  // only needs to discriminate between known processed, in-flight, or new.
  const duplicateReason = hasProcessedBlueBubblesMessage(agentName, normalized.chat.sessionKey, normalized.messageGuid)
    || hasProcessedBlueBubblesMessageGuid(agentName, normalized.messageGuid)
    ? "processed"
    : isBlueBubblesMessageInFlight(normalized.chat.sessionKey, normalized.messageGuid)
      ? "in_flight"
      : null
  if (
    normalized.messageGuid
    && duplicateReason
  ) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_repair_skipped_duplicate",
      message: "skipped repair+hydrate for already-processed bluebubbles messageGuid",
      meta: {
        messageGuid: normalized.messageGuid,
        sessionKey: normalized.chat.sessionKey,
        eventType: normalized.eventType,
        normalizedKind: normalized.kind,
        dedupeReason: duplicateReason,
      },
    })
    return handleBlueBubblesNormalizedEvent(normalized, resolvedDeps, "webhook")
  }
  const event = await client.repairEvent(normalized)
  return handleBlueBubblesNormalizedEvent(event, resolvedDeps, "webhook")
}

export interface BlueBubblesRecoveryResult {
  recovered: number
  skipped: number
  pending: number
  failed: number
}

export interface BlueBubblesCatchUpResult {
  inspected: number
  recovered: number
  skipped: number
  queued?: number
  failed: number
  lastRecoveredMessageGuid?: string
}

function countPendingRecoveryCandidates(agentName: string): number {
  return listBlueBubblesRecoveryCandidates(agentName)
    .filter((entry) => !hasProcessedBlueBubblesMessageGuid(agentName, entry.messageGuid))
    .length
}

function countPendingCapturedInboundMessages(agentName: string): number {
  return listPendingCapturedInboundMessages(agentName).length
}

function listPendingCapturedInboundMessages(agentName: string): ReturnType<typeof listRecordedBlueBubblesInbound> {
  const seenMessageGuids = new Set<string>()
  return listRecordedBlueBubblesInbound(agentName)
    .filter((entry) => {
      if (seenMessageGuids.has(entry.messageGuid)) return false
      seenMessageGuids.add(entry.messageGuid)
      return true
    })
    .filter((entry) => !hasProcessedBlueBubblesMessageGuid(agentName, entry.messageGuid))
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveBlueBubblesCatchUpSince(previousState: BlueBubblesRuntimeState, nowMs = Date.now()): number {
  if (previousState.upstreamStatus === "error") {
    return nowMs - BLUEBUBBLES_RECOVERY_CATCHUP_LOOKBACK_MS
  }

  const lastCheckedAt = parseTimestampMs(previousState.lastCheckedAt)
  if (lastCheckedAt !== null) {
    return Math.max(0, lastCheckedAt - BLUEBUBBLES_HEALTHY_CATCHUP_OVERLAP_MS)
  }

  return nowMs - BLUEBUBBLES_FIRST_CATCHUP_LOOKBACK_MS
}

function formatBlueBubblesRuntimeDetail(queued: number, failed: number): string {
  if (queued > 0) return `upstream reachable but iMessage is not caught up; ${queued} recovery item(s) queued`
  if (failed > 0) return `${failed} message(s) unrecoverable this cycle; upstream ok`
  return "upstream reachable"
}

function blueBubblesPendingRecoverySnapshot(agentName: string, nowMs = Date.now()): {
  pendingRecoveryCount: number
  oldestPendingRecoveryAt?: string
  oldestPendingRecoveryAgeMs?: number
} {
  const pendingRecordedAt = [
    ...listPendingCapturedInboundMessages(agentName).map((entry) => entry.recordedAt),
    ...listBlueBubblesRecoveryCandidates(agentName)
      .filter((entry) => !hasProcessedBlueBubblesMessageGuid(agentName, entry.messageGuid))
      .map((entry) => entry.recordedAt),
  ]
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((entry): entry is { value: string; ms: number } => Number.isFinite(entry.ms))
    .sort((left, right) => left.ms - right.ms)

  const oldest = pendingRecordedAt[0]
  return {
    pendingRecoveryCount: countPendingCapturedInboundMessages(agentName) + countPendingRecoveryCandidates(agentName),
    oldestPendingRecoveryAt: oldest?.value,
    oldestPendingRecoveryAgeMs: oldest ? Math.max(0, nowMs - oldest.ms) : undefined,
  }
}

async function syncBlueBubblesRuntime(deps: Partial<RuntimeDeps> = {}): Promise<void> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const checkedAt = new Date().toISOString()
  const previousState = readBlueBubblesRuntimeState(agentName)

  try {
    await client.checkHealth()
    const pendingBeforeCatchup = blueBubblesPendingRecoverySnapshot(agentName)
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "ok",
      detail: "upstream reachable; recovery pass running",
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingBeforeCatchup,
      lastRecoveredAt: previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
    const catchUp = await catchUpMissedBlueBubblesMessages(resolvedDeps, previousState, {
      processTurns: false,
    })
    const failed = catchUp.failed
    const pendingAfterCatchup = blueBubblesPendingRecoverySnapshot(agentName)
    const queued = pendingAfterCatchup.pendingRecoveryCount
    // upstreamStatus reflects whether BlueBubbles itself and the local bridge
    // can answer webhook traffic. The daemon status layer treats
    // pendingRecoveryCount as unhealthy for user-facing iMessage reachability,
    // while this field stays scoped to upstream transport reachability.
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "ok",
      detail: formatBlueBubblesRuntimeDetail(queued, failed),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingAfterCatchup,
      pendingRecoveryCount: queued,
      failedRecoveryCount: failed,
      lastRecoveredAt: previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
  } catch (error) {
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "error",
      detail: error instanceof Error ? error.message : String(error),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...blueBubblesPendingRecoverySnapshot(agentName),
      failedRecoveryCount: 0,
    })
  }
}

export interface BlueBubblesQueuedRecoveryResult {
  recovered: number
  skipped: number
  failed: number
  pendingRecoveryCount: number
}

export async function recoverQueuedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesQueuedRecoveryResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const previousState = readBlueBubblesRuntimeState(agentName)
  const initialPending = blueBubblesPendingRecoverySnapshot(agentName).pendingRecoveryCount
  if (initialPending === 0) {
    return { recovered: 0, skipped: 0, failed: 0, pendingRecoveryCount: 0 }
  }

  const captured = await recoverCapturedBlueBubblesInboundMessages(resolvedDeps)
  const recovery = await recoverMissedBlueBubblesMessages(resolvedDeps)
  const pendingSnapshot = blueBubblesPendingRecoverySnapshot(agentName)
  const pendingRecoveryCount = pendingSnapshot.pendingRecoveryCount
  const failed = captured.failed + recovery.failed
  const recovered = captured.recovered + recovery.recovered
  const skipped = captured.skipped + recovery.skipped
  const checkedAt = new Date().toISOString()

  try {
    await resolvedDeps.createClient().checkHealth()
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "ok",
      detail: formatBlueBubblesRuntimeDetail(pendingRecoveryCount, failed),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingSnapshot,
      failedRecoveryCount: failed,
      lastRecoveredAt: recovered > 0 ? checkedAt : previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
  } catch (error) {
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "error",
      detail: error instanceof Error ? error.message : String(error),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingSnapshot,
      failedRecoveryCount: failed,
      lastRecoveredAt: recovered > 0 ? checkedAt : previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
  }

  return { recovered, skipped, failed, pendingRecoveryCount }
}

export async function catchUpMissedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
  previousState?: BlueBubblesRuntimeState,
  options: { processTurns?: boolean } = {},
): Promise<BlueBubblesCatchUpResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const result: BlueBubblesCatchUpResult = { inspected: 0, recovered: 0, skipped: 0, failed: 0 }
  const state = previousState ?? readBlueBubblesRuntimeState(agentName)
  const catchUpSince = resolveBlueBubblesCatchUpSince(state)
  const processTurns = options.processTurns !== false

  /* v8 ignore next -- older injected test doubles may omit the catch-up query method */
  if (!client.listRecentMessages) return result

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_catchup_start",
    message: "bluebubbles upstream catch-up pass started",
    meta: {
      since: new Date(catchUpSince).toISOString(),
      pageSize: BLUEBUBBLES_CATCHUP_PAGE_SIZE,
      maxPages: BLUEBUBBLES_CATCHUP_MAX_PAGES,
    },
  })

  const recentEvents: BlueBubblesNormalizedEvent[] = []
  for (let page = 0; page < BLUEBUBBLES_CATCHUP_MAX_PAGES; page++) {
    let pageEvents: BlueBubblesNormalizedEvent[]
    try {
      pageEvents = await client.listRecentMessages({
        limit: BLUEBUBBLES_CATCHUP_PAGE_SIZE,
        offset: page * BLUEBUBBLES_CATCHUP_PAGE_SIZE,
      })
    } catch (error) {
      result.failed++
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_catchup_error",
        message: "bluebubbles upstream catch-up query failed",
        meta: {
          offset: page * BLUEBUBBLES_CATCHUP_PAGE_SIZE,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      break
    }

    recentEvents.push(...pageEvents)
    if (pageEvents.length < BLUEBUBBLES_CATCHUP_PAGE_SIZE) break

    const oldestMessageTimestamp = pageEvents
      .filter((event): event is BlueBubblesNormalizedMessage => event.kind === "message")
      .reduce((oldest, event) => Math.min(oldest, event.timestamp), Number.POSITIVE_INFINITY)
    if (oldestMessageTimestamp <= catchUpSince) break

    if (page === BLUEBUBBLES_CATCHUP_MAX_PAGES - 1) {
      result.failed++
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_catchup_error",
        message: "bluebubbles upstream catch-up reached the bounded page limit",
        meta: {
          inspectedPages: BLUEBUBBLES_CATCHUP_MAX_PAGES,
          reason: "catch-up page limit reached before the outage window cutoff",
        },
      })
    }
  }

  const seenMessageGuids = new Set<string>()
  const candidates = recentEvents
    .filter((event): event is BlueBubblesNormalizedMessage => event.kind === "message")
    .filter((event) => {
      if (seenMessageGuids.has(event.messageGuid)) return false
      seenMessageGuids.add(event.messageGuid)
      return true
    })
    .sort((left, right) => left.timestamp - right.timestamp)

  for (const event of candidates) {
    result.inspected++
    if (
      event.fromMe
      || event.timestamp < catchUpSince
      || hasProcessedBlueBubblesMessageGuid(agentName, event.messageGuid)
      || isBlueBubblesMessageInFlight(event.chat.sessionKey, event.messageGuid)
    ) {
      result.skipped++
      continue
    }

    if (!processTurns) {
      if (hasRecordedBlueBubblesInbound(agentName, event.chat.sessionKey, event.messageGuid)) {
        result.skipped++
        continue
      }
      recordBlueBubblesInbound(agentName, event, "upstream-catchup")
      result.queued = (result.queued ?? 0) + 1
      continue
    }

    let repairedMessage: BlueBubblesNormalizedMessage | null = null
    try {
      const repaired = await client.repairEvent(event)
      if (repaired.kind !== "message") {
        result.skipped++
        continue
      }
      repairedMessage = repaired

      const handled = await handleBlueBubblesNormalizedEvent(repaired, resolvedDeps, "upstream-catchup", {
        timeoutMs: BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS,
      })
      if (handled.reason === "already_processed") {
        result.skipped++
      } else {
        result.recovered++
        result.lastRecoveredMessageGuid = repaired.messageGuid
      }
    } catch (error) {
      result.failed++
      if (repairedMessage && isBlueBubblesRecoveryTurnTimeoutError(error)) {
        recordProcessedBlueBubblesMessage(agentName, repairedMessage, "upstream-catchup", "recovery-timeout")
      }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_catchup_error",
        message: "bluebubbles upstream catch-up message failed",
        meta: {
          messageGuid: event.messageGuid,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  if (result.inspected > 0 || result.recovered > 0 || result.skipped > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_catchup_complete",
      message: "bluebubbles upstream catch-up pass completed",
      meta: { ...result },
    })
  }

  return result
}

export interface BlueBubblesCapturedRecoveryResult {
  recovered: number
  skipped: number
  failed: number
}

function inboundEntryToRecoveryEvent(entry: ReturnType<typeof listRecordedBlueBubblesInbound>[number]): BlueBubblesNormalizedMessage {
  const chatIdentifier = entry.chatIdentifier ?? extractChatIdentifierFromSessionKey(entry.sessionKey) ?? "unknown"
  const normalizedSessionKey = normalizeBlueBubblesSessionKey(entry.sessionKey)
  const chatGuid = entry.chatGuid ?? (normalizedSessionKey.startsWith("chat:") ? normalizedSessionKey.slice("chat:".length) : undefined)
  const isGroup = normalizedSessionKey.includes("+;")
  return {
    kind: "message",
    eventType: "new-message",
    messageGuid: entry.messageGuid,
    timestamp: parseTimestampMs(entry.recordedAt) ?? Date.now(),
    fromMe: false,
    sender: {
      provider: "imessage-handle",
      externalId: chatIdentifier,
      rawId: chatIdentifier,
      displayName: chatIdentifier,
    },
    chat: {
      chatGuid,
      chatIdentifier,
      isGroup,
      sessionKey: normalizedSessionKey,
      sendTarget: chatGuid
        ? { kind: "chat_guid", value: chatGuid }
        : { kind: "chat_identifier", value: chatIdentifier },
      participantHandles: [],
    },
    text: entry.textForAgent,
    textForAgent: entry.textForAgent,
    attachments: [],
    hasPayloadData: false,
    requiresRepair: true,
  }
}

export async function recoverCapturedBlueBubblesInboundMessages(
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesCapturedRecoveryResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const result: BlueBubblesCapturedRecoveryResult = { recovered: 0, skipped: 0, failed: 0 }
  const seenMessageGuids = new Set<string>()

  const candidates = listRecordedBlueBubblesInbound(agentName)
    .filter((entry) => {
      if (seenMessageGuids.has(entry.messageGuid)) return false
      seenMessageGuids.add(entry.messageGuid)
      return true
    })
    .sort((left, right) => (parseTimestampMs(left.recordedAt) ?? 0) - (parseTimestampMs(right.recordedAt) ?? 0))

  for (const entry of candidates) {
    if (
      hasProcessedBlueBubblesMessage(agentName, entry.sessionKey, entry.messageGuid)
      || hasProcessedBlueBubblesMessageGuid(agentName, entry.messageGuid)
      || isBlueBubblesMessageInFlight(entry.sessionKey, entry.messageGuid)
    ) {
      result.skipped++
      continue
    }

    let repairedMessage: BlueBubblesNormalizedMessage | null = null
    try {
      const repaired = await client.repairEvent(inboundEntryToRecoveryEvent(entry))
      if (repaired.kind !== "message") {
        result.skipped++
        continue
      }
      repairedMessage = repaired

      const handled = await handleBlueBubblesNormalizedEvent(repaired, resolvedDeps, entry.source, {
        timeoutMs: BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS,
      })
      if (handled.reason === "already_processed") {
        result.skipped++
      } else {
        result.recovered++
      }
    } catch (error) {
      result.failed++
      if (repairedMessage && isBlueBubblesRecoveryTurnTimeoutError(error)) {
        recordProcessedBlueBubblesMessage(agentName, repairedMessage, entry.source, "recovery-timeout")
      }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_capture_recovery_error",
        message: "captured bluebubbles message recovery failed",
        meta: {
          messageGuid: entry.messageGuid,
          sessionKey: entry.sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  return result
}

export async function recoverMissedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesRecoveryResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const result: BlueBubblesRecoveryResult = { recovered: 0, skipped: 0, pending: 0, failed: 0 }

  for (const candidate of listBlueBubblesRecoveryCandidates(agentName)) {
    if (
      hasProcessedBlueBubblesMessage(agentName, candidate.sessionKey, candidate.messageGuid)
      || hasProcessedBlueBubblesMessageGuid(agentName, candidate.messageGuid)
      || isBlueBubblesMessageInFlight(candidate.sessionKey, candidate.messageGuid)
    ) {
      result.skipped++
      continue
    }

    let repairedMessage: BlueBubblesNormalizedMessage | null = null
    try {
      const repaired = await client.repairEvent(mutationEntryToEvent(candidate))
      if (repaired.kind !== "message") {
        result.pending++
        continue
      }
      repairedMessage = repaired

      const handled = await handleBlueBubblesNormalizedEvent(repaired, resolvedDeps, "mutation-recovery", {
        timeoutMs: BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS,
      })
      if (handled.reason === "already_processed") {
        result.skipped++
      } else {
        result.recovered++
      }
    } catch (error) {
      result.failed++
      if (repairedMessage && isBlueBubblesRecoveryTurnTimeoutError(error)) {
        recordProcessedBlueBubblesMessage(agentName, repairedMessage, "mutation-recovery", "recovery-timeout")
      }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_recovery_error",
        message: "bluebubbles backlog recovery failed",
        meta: {
          messageGuid: candidate.messageGuid,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  if (result.recovered > 0 || result.skipped > 0 || result.pending > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_recovery_complete",
      message: "bluebubbles backlog recovery pass completed",
      meta: { ...result },
    })
  }

  return result
}

export function createBlueBubblesWebhookHandler(
  deps: Partial<RuntimeDeps> = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (url.pathname === "/health") {
      if (req.method === "GET" || req.method === "HEAD") {
        writeJson(res, 200, { status: "ok", uptime: process.uptime() })
        return
      }
      writeJson(res, 405, { error: "Method not allowed" })
      return
    }

    const channelConfig = getBlueBubblesChannelConfig()
    const runtimeConfig = getBlueBubblesConfig()

    if (url.pathname !== channelConfig.webhookPath) {
      writeJson(res, 404, { error: "Not found" })
      return
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" })
      return
    }

    if (!isWebhookPasswordValid(url, runtimeConfig.password)) {
      writeJson(res, 401, { error: "Unauthorized" })
      return
    }

    let payload: unknown
    try {
      const rawBody = await readRequestBody(req)
      payload = JSON.parse(rawBody) as unknown
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_webhook_bad_json",
        message: "failed to parse bluebubbles webhook body",
        meta: {
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      writeJson(res, 400, { error: "Invalid JSON body" })
      return
    }

    let normalized: BlueBubblesNormalizedEvent
    try {
      normalized = normalizeBlueBubblesEvent(payload)
    } catch (error) {
      if (error instanceof BlueBubblesIgnoredEventError) {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_event_skipped",
          message: "skipped ignorable bluebubbles event",
          meta: {
            eventType: error.eventType,
          },
        })
        writeJson(res, 200, {
          handled: true,
          notifiedAgent: false,
          reason: "ignored",
        })
        return
      }
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_webhook_error",
        message: "bluebubbles webhook handling failed",
        meta: {
          /* v8 ignore next -- normalizeBlueBubblesEvent throws Error subclasses; String fallback is defensive @preserve */
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      writeJson(res, 500, {
        /* v8 ignore next -- normalizeBlueBubblesEvent throws Error subclasses; String fallback is defensive @preserve */
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const resolvedDeps = { ...defaultDeps, ...deps }
    if (normalized.kind === "message" && !normalized.fromMe) {
      recordBlueBubblesInbound(resolvedDeps.getAgentName(), normalized, "webhook")
    } else if (normalized.kind === "mutation") {
      try {
        resolvedDeps.recordMutation(resolvedDeps.getAgentName(), normalized)
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.bluebubbles_mutation_log_error",
          message: "failed recording bluebubbles mutation sidecar",
          meta: {
            messageGuid: normalized.messageGuid,
            mutationType: normalized.mutationType,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    writeJson(res, 200, {
      handled: true,
      notifiedAgent: false,
      kind: normalized.kind,
      queued: true,
      reason: "queued",
    })

    setTimeout(() => {
      void handleBlueBubblesEvent(payload, deps).catch((error) => {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.bluebubbles_webhook_async_error",
          message: "bluebubbles webhook async handling failed after durable capture",
          meta: {
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      })
    }, 0)
  }
}

export interface DrainAndSendPendingResult {
  sent: number
  skipped: number
  failed: number
}


function findImessageHandle(friend: FriendRecord): string | undefined {
  for (const ext of friend.externalIds) {
    if (ext.provider === "imessage-handle" && !ext.externalId.startsWith("group:")) {
      return ext.externalId
    }
  }
  return undefined
}

function normalizeBlueBubblesSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim()
  if (trimmed.startsWith("chat_identifier_")) {
    return `chat_identifier:${trimmed.slice("chat_identifier_".length)}`
  }
  if (trimmed.startsWith("chat_")) {
    return `chat:${trimmed.slice("chat_".length)}`
  }
  return trimmed
}

function extractChatIdentifierFromSessionKey(sessionKey: string): string | undefined {
  const normalizedKey = normalizeBlueBubblesSessionKey(sessionKey)
  if (normalizedKey.startsWith("chat:")) {
    const chatGuid = normalizedKey.slice("chat:".length).trim()
    const parts = chatGuid.split(";")
    return parts.length >= 3 ? parts[2]?.trim() || undefined : undefined
  }
  if (normalizedKey.startsWith("chat_identifier:")) {
    const identifier = normalizedKey.slice("chat_identifier:".length).trim()
    return identifier || undefined
  }
  return undefined
}

function buildChatRefForSessionKey(friend: FriendRecord, sessionKey: string): BlueBubblesChatRef | null {
  const normalizedKey = normalizeBlueBubblesSessionKey(sessionKey)
  if (normalizedKey.startsWith("chat:")) {
    const chatGuid = normalizedKey.slice("chat:".length).trim()
    if (!chatGuid) return null
    return {
      chatGuid,
      chatIdentifier: extractChatIdentifierFromSessionKey(sessionKey) ?? findImessageHandle(friend),
      isGroup: chatGuid.includes(";+;"),
      sessionKey,
      sendTarget: { kind: "chat_guid", value: chatGuid },
      participantHandles: [],
    }
  }

  const chatIdentifier = extractChatIdentifierFromSessionKey(sessionKey) ?? findImessageHandle(friend)
  if (!chatIdentifier) return null
  return {
    chatIdentifier,
    isGroup: false,
    sessionKey,
    sendTarget: { kind: "chat_identifier", value: chatIdentifier },
    participantHandles: [],
  }
}

export async function sendProactiveBlueBubblesMessageToSession(
  params: ProactiveBlueBubblesSessionSendParams,
  deps: Partial<RuntimeDeps> = {},
): Promise<ProactiveBlueBubblesSessionSendResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const client = resolvedDeps.createClient()
  const store = resolvedDeps.createFriendStore()

  let friend: FriendRecord | null
  try {
    friend = await store.get(params.friendId)
  } catch {
    friend = null
  }

  // Direct filesystem fallback — store.get() with name resolution wasn't working in production
  // despite correct compiled code. Bypass the entire store abstraction.
  /* v8 ignore start -- direct filesystem name resolution @preserve */
  if (!friend) {
    try {
      const friendsDir = path.join(getAgentRoot(), "friends")
      const files = fs.readdirSync(friendsDir).filter((f: string) => f.endsWith(".json"))
      for (const file of files) {
        const raw = JSON.parse(fs.readFileSync(path.join(friendsDir, file), "utf-8")) as FriendRecord
        if (raw.name?.toLowerCase() === params.friendId.toLowerCase()) {
          friend = raw
          emitNervesEvent({
            component: "senses",
            event: "senses.bluebubbles_proactive_name_resolved",
            message: "resolved friend by name via direct filesystem scan",
            meta: { friendId: params.friendId, resolvedId: raw.id, name: raw.name },
          })
          break
        }
      }
    } catch (err) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_proactive_name_resolve_error",
        message: "direct filesystem name resolution failed",
        meta: { friendId: params.friendId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
  /* v8 ignore stop */

  if (!friend) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_proactive_no_friend",
      message: "proactive send skipped: friend not found",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey },
    })
    return { delivered: false, reason: "friend_not_found" }
  }

  const explicitCrossChatAuthorized = params.intent === "explicit_cross_chat"
    && TRUSTED_LEVELS.has((params.authorizingSession?.trustLevel as any) ?? "stranger")

  if (!explicitCrossChatAuthorized && !TRUSTED_LEVELS.has(friend.trustLevel ?? "stranger")) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_proactive_trust_skip",
      message: "proactive send skipped: trust level not allowed",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
        trustLevel: friend.trustLevel ?? "unknown",
        intent: params.intent ?? "generic_outreach",
        authorizingTrustLevel: params.authorizingSession?.trustLevel ?? null,
      },
    })
    return { delivered: false, reason: "trust_skip" }
  }

  const chat = buildChatRefForSessionKey(friend, params.sessionKey)
  if (!chat) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_proactive_no_handle",
      message: "proactive send skipped: no iMessage handle found",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey },
    })
    return { delivered: false, reason: "missing_target" }
  }

  // Proactive outreach to individuals must go to DMs, never group chats.
  // Explicit cross-chat responses (bridge completions, delegation returns) ARE allowed to groups
  // because the request originated from that group.
  /* v8 ignore start -- group gate: only fires when proactive send targets a group session @preserve */
  if (chat.isGroup && params.intent !== "explicit_cross_chat") {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_proactive_group_blocked",
      message: "proactive send blocked: would route to group chat",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey, chatGuid: chat.chatGuid ?? null, intent: params.intent ?? null },
    })
    return { delivered: false, reason: "group_blocked" }
  }
  /* v8 ignore stop */

  const internalContentBlockReason = getProactiveInternalContentBlockReason(params.text)
  if (internalContentBlockReason) {
    emitProactiveInternalContentBlocked({
      friendId: params.friendId,
      sessionKey: params.sessionKey,
      reason: internalContentBlockReason,
      source: "session_send",
      intent: params.intent ?? "generic_outreach",
    })
    return { delivered: false, reason: "internal_content_blocked" }
  }

  try {
    await client.sendText({ chat, text: params.text })
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_proactive_sent",
      message: "proactive bluebubbles message sent",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
        chatGuid: chat.chatGuid ?? null,
        chatIdentifier: chat.chatIdentifier ?? null,
      },
    })
    return { delivered: true }
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.bluebubbles_proactive_send_error",
      message: "proactive bluebubbles send failed",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return { delivered: false, reason: "send_error" }
  }
}

function scanPendingBlueBubblesFiles(pendingRoot: string): Array<{
  friendId: string
  key: string
  filePath: string
  content: string
}> {
  const results: Array<{ friendId: string; key: string; filePath: string; content: string }> = []

  let friendIds: string[]
  try {
    friendIds = fs.readdirSync(pendingRoot)
  } catch {
    return results
  }

  for (const friendId of friendIds) {
    const bbDir = path.join(pendingRoot, friendId, "bluebubbles")
    let keys: string[]
    try {
      keys = fs.readdirSync(bbDir)
    } catch {
      continue
    }

    for (const key of keys) {
      const keyDir = path.join(bbDir, key)
      let files: string[]
      try {
        files = fs.readdirSync(keyDir)
      } catch {
        continue
      }

      for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
        const filePath = path.join(keyDir, file)
        try {
          const content = fs.readFileSync(filePath, "utf-8")
          results.push({ friendId, key, filePath, content })
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return results
}

export async function drainAndSendPendingBlueBubbles(
  deps: Partial<RuntimeDeps> = {},
  pendingRoot?: string,
): Promise<DrainAndSendPendingResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const root = pendingRoot ?? path.join(getAgentRoot(), "state", "pending")
  const client = resolvedDeps.createClient()
  const store = resolvedDeps.createFriendStore()

  const pendingFiles = scanPendingBlueBubblesFiles(root)
  const result: DrainAndSendPendingResult = { sent: 0, skipped: 0, failed: 0 }

  for (const { friendId, filePath, content } of pendingFiles) {
    let parsed: { content?: string }
    try {
      parsed = JSON.parse(content) as { content?: string }
    } catch {
      result.failed++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    const messageText = typeof parsed.content === "string" ? parsed.content : ""
    if (!messageText.trim()) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    const internalBlockReason = getProactiveInternalContentBlockReason(messageText)
    if (internalBlockReason) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitProactiveInternalContentBlocked({
        friendId,
        reason: internalBlockReason,
        source: "pending_drain",
      })
      continue
    }

    let friend: FriendRecord | null
    try {
      friend = await store.get(friendId)
    } catch {
      friend = null
    }

    if (!friend) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_proactive_no_friend",
        message: "proactive send skipped: friend not found",
        meta: { friendId },
      })
      continue
    }

    if (!TRUSTED_LEVELS.has(friend.trustLevel ?? "stranger")) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_proactive_trust_skip",
        message: "proactive send skipped: trust level not allowed",
        meta: { friendId, trustLevel: friend.trustLevel ?? "unknown" },
      })
      continue
    }

    const handle = findImessageHandle(friend)
    if (!handle) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_proactive_no_handle",
        message: "proactive send skipped: no iMessage handle found",
        meta: { friendId },
      })
      continue
    }

    const chat: BlueBubblesChatRef = {
      chatIdentifier: handle,
      isGroup: false,
      sessionKey: friendId,
      sendTarget: { kind: "chat_identifier", value: handle },
      participantHandles: [],
    }

    try {
      await client.sendText({ chat, text: messageText })
      result.sent++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_proactive_sent",
        message: "proactive bluebubbles message sent",
        meta: { friendId, handle },
      })
    } catch (error) {
      result.failed++
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_proactive_send_error",
        message: "proactive bluebubbles send failed",
        meta: {
          friendId,
          handle,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  if (result.sent > 0 || result.skipped > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_proactive_drain_complete",
      message: "bluebubbles proactive drain complete",
      meta: { sent: result.sent, skipped: result.skipped, failed: result.failed },
    })
  }

  return result
}

export function startBlueBubblesApp(deps: Partial<RuntimeDeps> = {}): http.Server {
  const resolvedDeps = { ...defaultDeps, ...deps }
  resolvedDeps.createClient()
  const channelConfig = getBlueBubblesChannelConfig()
  const server = resolvedDeps.createServer(createBlueBubblesWebhookHandler(deps))
  let recoveryPassRunning = false
  let recoveryDelayTimer: ReturnType<typeof setTimeout> | null = null

  function triggerRecoveryPass(): void {
    /* v8 ignore next -- re-entrant timer guard; difficult to force deterministically without timing the turn lock @preserve */
    if (recoveryPassRunning) return
    recoveryPassRunning = true
    void recoverQueuedBlueBubblesMessages(resolvedDeps)
      /* v8 ignore start -- defensive wrapper; expected per-message failures are handled inside recovery helpers @preserve */
      .catch((error) => {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_recovery_error",
          message: "bluebubbles queued recovery pass failed",
          meta: { reason: error instanceof Error ? error.message : String(error) },
        })
      })
      /* v8 ignore stop */
      .finally(() => {
        recoveryPassRunning = false
      })
  }

  function scheduleRecoveryPass(): void {
    /* v8 ignore next -- duplicate scheduling guard for overlapping health sync completions @preserve */
    if (recoveryDelayTimer !== null) return
    recoveryDelayTimer = setTimeout(() => {
      recoveryDelayTimer = null
      triggerRecoveryPass()
    }, BLUEBUBBLES_RECOVERY_PASS_DELAY_MS)
  }

  const runtimeTimer = setInterval(() => {
    void syncBlueBubblesRuntime(resolvedDeps).then(scheduleRecoveryPass)
  }, BLUEBUBBLES_RUNTIME_SYNC_INTERVAL_MS)
  const recoveryTimer = setInterval(triggerRecoveryPass, BLUEBUBBLES_RECOVERY_PASS_INTERVAL_MS)
  server.on?.("close", () => {
    clearInterval(runtimeTimer)
    clearInterval(recoveryTimer)
    if (recoveryDelayTimer !== null) {
      clearTimeout(recoveryDelayTimer)
      recoveryDelayTimer = null
    }
  })
  server.listen(channelConfig.port, () => {
    emitNervesEvent({
      component: "channels",
      event: "channel.app_started",
      message: "BlueBubbles sense started",
      meta: { port: channelConfig.port, webhookPath: channelConfig.webhookPath },
    })
  })
  void syncBlueBubblesRuntime(resolvedDeps).then(scheduleRecoveryPass)
  return server
}
