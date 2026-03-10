import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import OpenAI from "openai"
import { runAgent, type ChannelCallbacks, type RunAgentOptions, createSummarize } from "../heart/core"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig, sessionPath } from "../heart/config"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { loadSession, postTurn } from "../mind/context"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import { FriendResolver, type FriendResolverParams } from "../mind/friends/resolver"
import { FileFriendStore } from "../mind/friends/store-file"
import type { FriendRecord } from "../mind/friends/types"
import { buildSystem } from "../mind/prompt"
import { getPhrases } from "../mind/phrases"
import { emitNervesEvent } from "../nerves/runtime"
import type { BlueBubblesReplyTargetSelection } from "../repertoire/tools-base"
import {
  normalizeBlueBubblesEvent,
  type BlueBubblesChatRef,
  type BlueBubblesNormalizedEvent,
} from "./bluebubbles-model"
import { createBlueBubblesClient, type BlueBubblesClient } from "./bluebubbles-client"
import { recordBlueBubblesMutation } from "./bluebubbles-mutation-log"
import { findObsoleteBlueBubblesThreadSessions } from "./bluebubbles-session-cleanup"
import { createDebugActivityController } from "./debug-activity"

type BlueBubblesCallbacks = ChannelCallbacks & {
  flush(): Promise<void>
  finish(): Promise<void>
}

export interface BlueBubblesHandleResult {
  handled: boolean
  notifiedAgent: boolean
  kind?: BlueBubblesNormalizedEvent["kind"]
  reason?: "from_me" | "mutation_state_only"
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
      .find(Boolean)
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
): BlueBubblesCallbacks {
  let textBuffer = ""
  const phrases = getPhrases()
  const activity = createDebugActivityController({
    thinkingPhrases: phrases.thinking,
    followupPhrases: phrases.followup,
    startTypingOnModelStart: true,
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

export async function handleBlueBubblesEvent(
  payload: unknown,
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesHandleResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const client = resolvedDeps.createClient()
  const event = await client.repairEvent(normalizeBlueBubblesEvent(payload))

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

  const store = resolvedDeps.createFriendStore()
  const resolver = resolvedDeps.createFriendResolver(store, resolveFriendParams(event))
  const context = await resolver.resolve()
  const replyTarget = createReplyTargetController(event)
  const toolContext = {
    signin: async () => undefined,
    friendStore: store,
    summarize: createSummarize(),
    context,
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
  }

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
  const existing = resolvedDeps.loadSession(sessPath)
  const messages: OpenAI.ChatCompletionMessageParam[] =
    existing?.messages && existing.messages.length > 0
      ? existing.messages
      : [{ role: "system", content: await resolvedDeps.buildSystem("bluebubbles", undefined, context) }]

  messages.push({ role: "user", content: buildInboundContent(event, existing?.messages ?? messages) })

  const callbacks = createBlueBubblesCallbacks(
    client,
    event.chat,
    replyTarget,
  )
  const controller = new AbortController()
  const agentOptions: RunAgentOptions = {
    toolContext,
  }

  try {
    const result = await resolvedDeps.runAgent(messages, callbacks, "bluebubbles", controller.signal, agentOptions)
    await callbacks.flush()
    resolvedDeps.postTurn(messages, sessPath, result.usage)
    await resolvedDeps.accumulateFriendTokens(store, friendId, result.usage)

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

const PROACTIVE_SEND_ALLOWED_TRUST: ReadonlySet<string> = new Set(["family", "friend"])

function findImessageHandle(friend: FriendRecord): string | undefined {
  for (const ext of friend.externalIds) {
    if (ext.provider === "imessage-handle" && !ext.externalId.startsWith("group:")) {
      return ext.externalId
    }
  }
  return undefined
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

    if (!PROACTIVE_SEND_ALLOWED_TRUST.has(friend.trustLevel ?? "stranger")) {
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
  server.listen(channelConfig.port, () => {
    emitNervesEvent({
      component: "channels",
      event: "channel.app_started",
      message: "BlueBubbles sense started",
      meta: { port: channelConfig.port, webhookPath: channelConfig.webhookPath },
    })
  })
  return server
}
