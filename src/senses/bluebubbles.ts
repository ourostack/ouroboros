import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import OpenAI from "openai"
import { runAgent, type ChannelCallbacks, createSummarize } from "../heart/core"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig, sessionPath } from "../heart/config"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { withSharedTurnLock } from "../heart/turn-coordinator"
import { loadSession, postTurn } from "../mind/context"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import { upsertGroupContextParticipants } from "../mind/friends/group-context"
import { FriendResolver, type FriendResolverParams } from "../mind/friends/resolver"
import { FileFriendStore } from "../mind/friends/store-file"
import { TRUSTED_LEVELS, type FriendRecord } from "../mind/friends/types"
import { getChannelCapabilities } from "../mind/friends/channel"
import { getPendingDir, drainDeferredReturns, drainPending } from "../mind/pending"
import { buildSystem } from "../mind/prompt"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { getPhrases } from "../mind/phrases"
import { emitNervesEvent } from "../nerves/runtime"
import type { BlueBubblesReplyTargetSelection } from "../repertoire/tools-base"
import {
  normalizeBlueBubblesEvent,
  type BlueBubblesChatRef,
  type BlueBubblesNormalizedEvent,
  type BlueBubblesNormalizedMessage,
  type BlueBubblesNormalizedMutation,
} from "./bluebubbles-model"
import { createBlueBubblesClient, type BlueBubblesClient } from "./bluebubbles-client"
import { hasRecordedBlueBubblesInbound, recordBlueBubblesInbound, type BlueBubblesInboundSource } from "./bluebubbles-inbound-log"
import { listBlueBubblesRecoveryCandidates, recordBlueBubblesMutation, type BlueBubblesMutationLogEntry } from "./bluebubbles-mutation-log"
import { writeBlueBubblesRuntimeState } from "./bluebubbles-runtime-state"
import { findObsoleteBlueBubblesThreadSessions } from "./bluebubbles-session-cleanup"
import { createDebugActivityController } from "./debug-activity"
import { enforceTrustGate } from "./trust-gate"
import { handleInboundTurn } from "./pipeline"

type BlueBubblesCallbacks = ChannelCallbacks & {
  flush(): Promise<void>
  finish(): Promise<void>
}

export interface BlueBubblesHandleResult {
  handled: boolean
  notifiedAgent: boolean
  kind?: BlueBubblesNormalizedEvent["kind"]
  reason?: "from_me" | "mutation_state_only" | "already_processed"
}

interface RuntimeDeps {
  getAgentName: typeof getAgentName
  buildSystem: typeof buildSystem
  runAgent: typeof runAgent
  loadSession: typeof loadSession
  postTurn: typeof postTurn
  sessionPath: typeof sessionPath
  accumulateFriendTokens: typeof accumulateFriendTokens
  createClient: () => BlueBubblesClient
  recordMutation: typeof recordBlueBubblesMutation
  createFriendStore: () => FileFriendStore
  createFriendResolver: (store: FileFriendStore, params: FriendResolverParams) => FriendResolver
  createServer: typeof http.createServer
}

interface BlueBubblesReplyTargetController {
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
  reason?: "friend_not_found" | "trust_skip" | "missing_target" | "send_error"
}

const defaultDeps: RuntimeDeps = {
  getAgentName,
  buildSystem,
  runAgent,
  loadSession,
  postTurn,
  sessionPath,
  accumulateFriendTokens,
  createClient: () => createBlueBubblesClient(),
  recordMutation: recordBlueBubblesMutation,
  createFriendStore: () => new FileFriendStore(path.join(getAgentRoot(), "friends")),
  createFriendResolver: (store, params) => new FriendResolver(store, params),
  createServer: http.createServer,
}

const BLUEBUBBLES_RUNTIME_SYNC_INTERVAL_MS = 30_000

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
): string {
  const metadataPrefix = buildConversationScopePrefix(event, existingMessages)
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
): OpenAI.ChatCompletionUserMessageParam["content"] {
  const text = buildInboundText(event, existingMessages)
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

function createBlueBubblesCallbacks(
  client: BlueBubblesClient,
  chat: BlueBubblesChatRef,
  replyTarget: BlueBubblesReplyTargetController,
  isGroupChat: boolean,
): BlueBubblesCallbacks {
  let textBuffer = ""
  const phrases = getPhrases()
  const activity = createDebugActivityController({
    thinkingPhrases: phrases.thinking,
    followupPhrases: phrases.followup,
    startTypingOnModelStart: !isGroupChat,
    startTypingOnFirstTextChunk: isGroupChat,
    suppressInitialModelStatus: true,
    suppressFollowupPhraseStatus: true,
    transport: {
      sendStatus: async (text: string) => {
        const sent = await client.sendText({
          chat,
          text,
          replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
        })
        return sent.messageGuid
      },
      editStatus: async (_messageGuid: string, text: string) => {
        await client.sendText({
          chat,
          text,
          replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
        })
      },
      setTyping: async (active: boolean) => {
        if (!active) {
          await client.setTyping(chat, false)
          return
        }

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
      },
    },
    onTransportError: (operation, error) => {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_activity_error",
        message: "bluebubbles activity transport failed",
        meta: {
          operation,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    },
  })

  return {
    onModelStart(): void {
      activity.onModelStart()
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
      activity.onTextChunk(text)
      textBuffer += text
    },

    onReasoningChunk(_text: string): void {},

    onToolStart(name: string, _args: Record<string, string>): void {
      activity.onToolStart(name, _args)
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_tool_start",
        message: "bluebubbles tool execution started",
        meta: { name },
      })
    },

    onToolEnd(name: string, summary: string, success: boolean): void {
      activity.onToolEnd(name, summary, success)
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_tool_end",
        message: "bluebubbles tool execution completed",
        meta: { name, success, summary },
      })
    },

    onError(error: Error, severity: "transient" | "terminal"): void {
      activity.onError(error)
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

    async flush(): Promise<void> {
      await activity.drain()
      const trimmed = textBuffer.trim()
      if (!trimmed) {
        await activity.finish()
        return
      }
      textBuffer = ""
      await activity.finish()
      await client.sendText({
        chat,
        text: trimmed,
        replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
      })
    },

    async finish(): Promise<void> {
      await activity.finish()
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

async function handleBlueBubblesNormalizedEvent(
  event: BlueBubblesNormalizedEvent,
  resolvedDeps: RuntimeDeps,
  source: BlueBubblesInboundSource,
): Promise<BlueBubblesHandleResult> {
  const client = resolvedDeps.createClient()
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

  return withSharedTurnLock("bluebubbles", sessPath, async () => {
    // Pre-load session inside the turn lock so same-chat deliveries cannot race on stale trunk state.
    const existing = resolvedDeps.loadSession(sessPath)
    const mcpManager = await getSharedMcpManager() ?? undefined
    const sessionMessages: OpenAI.ChatCompletionMessageParam[] =
      existing?.messages && existing.messages.length > 0
        ? existing.messages
        : [{ role: "system", content: await resolvedDeps.buildSystem("bluebubbles", { mcpManager }, context) }]

    if (event.kind === "message") {
      const agentName = resolvedDeps.getAgentName()
      if (hasRecordedBlueBubblesInbound(agentName, event.chat.sessionKey, event.messageGuid)) {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_recovery_skip",
          message: "skipped bluebubbles message already recorded as handled",
          meta: {
            messageGuid: event.messageGuid,
            sessionKey: event.chat.sessionKey,
            source,
          },
        })
        return { handled: true, notifiedAgent: false, kind: event.kind, reason: "already_processed" }
      }

      if (source !== "webhook" && sessionLikelyContainsMessage(event, existing?.messages ?? sessionMessages)) {
        recordBlueBubblesInbound(agentName, event, "recovery-bootstrap")
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

    // Build inbound user message (adapter concern: BB-specific content formatting)
    const userMessage: OpenAI.ChatCompletionMessageParam = {
      role: "user",
      content: buildInboundContent(event, existing?.messages ?? sessionMessages),
    }

    const callbacks = createBlueBubblesCallbacks(
      client,
      event.chat,
      replyTarget,
      event.chat.isGroup,
    )
    const controller = new AbortController()

    // BB-specific tool context wrappers
    const summarize = createSummarize()

    const bbCapabilities = getChannelCapabilities("bluebubbles")
    const pendingDir = getPendingDir(resolvedDeps.getAgentName(), friendId, "bluebubbles", event.chat.sessionKey)

    // ── Compute trust gate context for group/acquaintance rules ─────
    const groupHasFamilyMember = await checkGroupHasFamilyMember(store, event)
    const hasExistingGroupWithFamily = event.chat.isGroup
      ? false
      : await checkHasExistingGroupWithFamily(store, context.friend)

    // ── Call shared pipeline ──────────────────────────────────────────

    try {
      const result = await handleInboundTurn({
        channel: "bluebubbles",
        sessionKey: event.chat.sessionKey,
        capabilities: bbCapabilities,
        messages: [userMessage],
        continuityIngressTexts: getBlueBubblesContinuityIngressTexts(event),
        callbacks,
        friendResolver: { resolve: () => Promise.resolve(context) },
        sessionLoader: {
          loadOrCreate: () => Promise.resolve({
            messages: sessionMessages,
            sessionPath: sessPath,
            state: existing?.state,
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
        postTurn: resolvedDeps.postTurn,
        accumulateFriendTokens: resolvedDeps.accumulateFriendTokens,
        signal: controller.signal,
        runAgentOptions: { mcpManager },
      })

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
          recordBlueBubblesInbound(resolvedDeps.getAgentName(), event, source)
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
        recordBlueBubblesInbound(resolvedDeps.getAgentName(), event, source)
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
      await callbacks.finish()
    }
  })
}

export async function handleBlueBubblesEvent(
  payload: unknown,
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesHandleResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const client = resolvedDeps.createClient()
  const event = await client.repairEvent(normalizeBlueBubblesEvent(payload))
  return handleBlueBubblesNormalizedEvent(event, resolvedDeps, "webhook")
}

export interface BlueBubblesRecoveryResult {
  recovered: number
  skipped: number
  pending: number
  failed: number
}

function countPendingRecoveryCandidates(agentName: string): number {
  return listBlueBubblesRecoveryCandidates(agentName)
    .filter((entry) => !hasRecordedBlueBubblesInbound(agentName, entry.sessionKey, entry.messageGuid))
    .length
}

async function syncBlueBubblesRuntime(deps: Partial<RuntimeDeps> = {}): Promise<void> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const checkedAt = new Date().toISOString()

  try {
    await client.checkHealth()
    const recovery = await recoverMissedBlueBubblesMessages(resolvedDeps)
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: recovery.pending > 0 || recovery.failed > 0 ? "error" : "ok",
      detail: recovery.failed > 0
        ? `recovery failures: ${recovery.failed}`
        : recovery.pending > 0
          ? `pending recovery: ${recovery.pending}`
          : "upstream reachable",
      lastCheckedAt: checkedAt,
      pendingRecoveryCount: recovery.pending,
      lastRecoveredAt: recovery.recovered > 0 ? checkedAt : undefined,
    })
  } catch (error) {
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "error",
      detail: error instanceof Error ? error.message : String(error),
      lastCheckedAt: checkedAt,
      pendingRecoveryCount: countPendingRecoveryCandidates(agentName),
    })
  }
}

export async function recoverMissedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesRecoveryResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const result: BlueBubblesRecoveryResult = { recovered: 0, skipped: 0, pending: 0, failed: 0 }

  for (const candidate of listBlueBubblesRecoveryCandidates(agentName)) {
    if (hasRecordedBlueBubblesInbound(agentName, candidate.sessionKey, candidate.messageGuid)) {
      result.skipped++
      continue
    }

    try {
      const repaired = await client.repairEvent(mutationEntryToEvent(candidate))
      if (repaired.kind !== "message") {
        result.pending++
        continue
      }

      const handled = await handleBlueBubblesNormalizedEvent(repaired, resolvedDeps, "mutation-recovery")
      if (handled.reason === "already_processed") {
        result.skipped++
      } else {
        result.recovered++
      }
    } catch (error) {
      result.failed++
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

    try {
      const result = await handleBlueBubblesEvent(payload, deps)
      writeJson(res, 200, result)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_webhook_error",
        message: "bluebubbles webhook handling failed",
        meta: {
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
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
  const runtimeTimer = setInterval(() => {
    void syncBlueBubblesRuntime(resolvedDeps)
  }, BLUEBUBBLES_RUNTIME_SYNC_INTERVAL_MS)
  server.on?.("close", () => {
    clearInterval(runtimeTimer)
  })
  server.listen(channelConfig.port, () => {
    emitNervesEvent({
      component: "channels",
      event: "channel.app_started",
      message: "BlueBubbles sense started",
      meta: { port: channelConfig.port, webhookPath: channelConfig.webhookPath },
    })
  })
  void syncBlueBubblesRuntime(resolvedDeps)
  return server
}
