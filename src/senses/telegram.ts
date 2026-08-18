import * as path from "node:path"

import { getAgentRoot } from "../heart/identity"
import { readRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { runSenseTurn, type RunSenseTurnOptions, type RunSenseTurnResult } from "./shared-turn"
import {
  createTelegramBotApi,
  createTelegramLongPoll,
  FileTelegramOffsetStore,
  sendTelegramText,
  type TelegramApprovalTransport,
  type TelegramBotApi,
  type TelegramInboundMessage,
  type TelegramLongPoll,
  type TelegramLongPollOptions,
  type TelegramOffsetStore,
  type TelegramUpdate,
} from "./telegram-client"

export interface TelegramSenseCredentials {
  botToken: string
  authorizedUserId: string
  authorizedChatId: string
}

export interface TelegramSenseApp {
  run(signal?: AbortSignal): Promise<void>
  sendProactive(text: string, signal?: AbortSignal): Promise<void>
  stop(): void
}

type TelegramTurnRunner = (options: RunSenseTurnOptions) => Promise<RunSenseTurnResult>
type TelegramLongPollFactory = (options: TelegramLongPollOptions) => TelegramLongPoll

export interface CreateTelegramSenseAppOptions {
  agentName: string
  credentials: TelegramSenseCredentials
  api?: TelegramBotApi
  offsetStore?: TelegramOffsetStore
  createLongPoll?: TelegramLongPollFactory
  runTurn?: TelegramTurnRunner
  approvalTransport?: TelegramApprovalTransport
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Telegram ${label} is missing`)
  return value.trim()
}

function canonicalTelegramId(value: unknown, label: string): string {
  const text = requiredText(value, label)
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(`Telegram ${label} must be a canonical positive decimal string`)
  return text
}

export function parseTelegramSenseCredentials(value: Record<string, unknown>): TelegramSenseCredentials {
  return {
    botToken: requiredText(value.telegramBotToken, "bot token"),
    authorizedUserId: canonicalTelegramId(value.telegramAuthorizedUserId, "authorized user id"),
    authorizedChatId: canonicalTelegramId(value.telegramAuthorizedChatId, "authorized chat id"),
  }
}

export function createTelegramSenseApp(options: CreateTelegramSenseAppOptions): TelegramSenseApp {
  const botToken = requiredText(options.credentials.botToken, "bot token")
  const authorizedUserId = canonicalTelegramId(options.credentials.authorizedUserId, "authorized user id")
  const authorizedChatId = canonicalTelegramId(options.credentials.authorizedChatId, "authorized chat id")
  const api = options.api ?? createTelegramBotApi({ token: botToken })
  const offsetStore = options.offsetStore ?? new FileTelegramOffsetStore(
    path.join(getAgentRoot(options.agentName), "state", "senses", "telegram", "offset.json"),
  )
  const runTurn = options.runTurn ?? runSenseTurn

  const deliver = async (text: string, signal?: AbortSignal): Promise<void> => {
    await sendTelegramText(api, authorizedChatId, text, signal)
  }

  const onMessage = async (message: TelegramInboundMessage): Promise<void> => {
    emitNervesEvent({
      component: "senses",
      event: "senses.telegram_turn_start",
      message: "Telegram authorized turn started",
      meta: { agentName: options.agentName, updateId: message.updateId, messageId: message.messageId },
    })
    let deliveryCount = 0
    try {
      const result = await runTurn({
        agentName: options.agentName,
        channel: "telegram",
        sessionKey: `telegram:${authorizedChatId}`,
        friendId: `telegram-user:${authorizedUserId}`,
        identity: {
          provider: "telegram-user",
          externalId: authorizedUserId,
          displayName: `Telegram user ${authorizedUserId}`,
        },
        userMessage: message.text,
        deliverySink: {
          onDelivery: async (delivery) => {
            await deliver(delivery.text)
            deliveryCount += 1
          },
        },
      })
      if (deliveryCount === 0 && result.response.trim()) await deliver(result.response)
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_turn_end",
        message: "Telegram authorized turn completed",
        meta: { agentName: options.agentName, updateId: message.updateId, deliveryCount: Math.max(deliveryCount, result.response.trim() ? 1 : 0) },
      })
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.telegram_turn_error",
        message: "Telegram authorized turn failed",
        meta: { agentName: options.agentName, updateId: message.updateId, error: error instanceof Error ? error.message : String(error) },
      })
      await deliver("I couldn't complete that turn. The failure was recorded; please try again.")
    }
  }

  const onUpdate = async (update: TelegramUpdate): Promise<boolean> => {
    if (!update.callback_query || !options.approvalTransport) return false
    const result = await options.approvalTransport.handleUpdate(update)
    return result.handled
  }

  const poll = (options.createLongPoll ?? createTelegramLongPoll)({
    api,
    expectedUserId: authorizedUserId,
    expectedChatId: authorizedChatId,
    offsetStore,
    onMessage,
    onUpdate,
  })

  return {
    async run(signal) {
      await options.approvalTransport?.reconcileExpired()
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_poll_start",
        message: "Telegram long poll started",
        meta: { agentName: options.agentName },
      })
      await poll.run(signal)
    },
    async sendProactive(text, signal) {
      await deliver(requiredText(text, "proactive message"), signal)
    },
    stop() {
      poll.stop()
      api.stop()
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_poll_end",
        message: "Telegram long poll stopped",
        meta: { agentName: options.agentName },
      })
    },
  }
}

export function loadTelegramSenseCredentials(agentName: string): TelegramSenseCredentials {
  const runtime = readRuntimeCredentialConfig(agentName)
  if (!runtime.ok) {
    throw new Error(`Telegram runtime config is ${runtime.reason}; actor: agent-runnable; run ouro connect telegram --agent ${agentName}`)
  }
  return parseTelegramSenseCredentials(runtime.config)
}

export async function startTelegramSenseApp(agentName: string): Promise<TelegramSenseApp> {
  const app = createTelegramSenseApp({ agentName, credentials: loadTelegramSenseCredentials(agentName) })
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_app_ready",
    message: "Telegram sense app is ready",
    meta: { agentName },
  })
  return app
}
