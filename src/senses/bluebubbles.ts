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
import { buildSystem } from "../mind/prompt"
import { getPhrases } from "../mind/phrases"
import { emitNervesEvent } from "../nerves/runtime"
import {
  normalizeBlueBubblesEvent,
  type BlueBubblesChatRef,
  type BlueBubblesNormalizedEvent,
} from "./bluebubbles-model"
import { createBlueBubblesClient, type BlueBubblesClient } from "./bluebubbles-client"
import { recordBlueBubblesMutation } from "./bluebubbles-mutation-log"
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

function buildInboundText(event: BlueBubblesNormalizedEvent): string {
  const baseText = event.repairNotice?.trim()
    ? `${event.textForAgent}\n[${event.repairNotice.trim()}]`
    : event.textForAgent
  if (!event.chat.isGroup) return baseText
  if (event.kind === "mutation") {
    return `${event.sender.displayName} ${baseText}`
  }
  return `${event.sender.displayName}: ${baseText}`
}

function buildInboundContent(event: BlueBubblesNormalizedEvent): OpenAI.ChatCompletionUserMessageParam["content"] {
  const text = buildInboundText(event)
  if (event.kind !== "message" || !event.inputPartsForAgent || event.inputPartsForAgent.length === 0) {
    return text
  }

  return [
    { type: "text", text },
    ...event.inputPartsForAgent,
  ]
}

function createBlueBubblesCallbacks(
  client: BlueBubblesClient,
  chat: BlueBubblesChatRef,
  replyToMessageGuid?: string,
): BlueBubblesCallbacks {
  let textBuffer = ""
  const phrases = getPhrases()
  const activity = createDebugActivityController({
    thinkingPhrases: phrases.thinking,
    followupPhrases: phrases.followup,
    transport: {
      sendStatus: async (text: string) => {
        const sent = await client.sendText({
          chat,
          text,
          replyToMessageGuid,
        })
        return sent.messageGuid
      },
      editStatus: async (messageGuid: string, text: string) => {
        await client.editMessage({
          messageGuid,
          text,
        })
      },
      setTyping: async (active: boolean) => {
        await client.setTyping(chat, active)
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
      await client.sendText({
        chat,
        text: trimmed,
        replyToMessageGuid,
      })
      await activity.finish()
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
  const toolContext = {
    signin: async () => undefined,
    friendStore: store,
    summarize: createSummarize(),
    context,
  }

  const friendId = context.friend.id
  const sessPath = resolvedDeps.sessionPath(friendId, "bluebubbles", event.chat.sessionKey)
  const existing = resolvedDeps.loadSession(sessPath)
  const messages: OpenAI.ChatCompletionMessageParam[] =
    existing?.messages && existing.messages.length > 0
      ? existing.messages
      : [{ role: "system", content: await resolvedDeps.buildSystem("bluebubbles", undefined, context) }]

  messages.push({ role: "user", content: buildInboundContent(event) })

  const callbacks = createBlueBubblesCallbacks(
    client,
    event.chat,
    event.kind === "message" ? event.messageGuid : undefined,
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
    try {
      await client.markChatRead(event.chat)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_mark_read_error",
        message: "failed to mark bluebubbles chat as read",
        meta: {
          chatGuid: event.chat.chatGuid ?? null,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
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
