import { createHmac } from "node:crypto"
import * as path from "node:path"

import { getAgentRoot } from "../heart/identity"
import { readRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { runSenseTurn, type RunSenseTurnOptions, type RunSenseTurnResult } from "./shared-turn"
import {
  createTelegramBotApi,
  createTelegramLongPoll,
  FileTelegramOffsetStore,
  FileTelegramUpdateInboxStore,
  sendTelegramText,
  type TelegramApprovalTransport,
  type TelegramBotApi,
  type TelegramInboundMessage,
  type TelegramLongPoll,
  type TelegramLongPollOptions,
  type TelegramOffsetStore,
  type TelegramUpdateInboxStore,
  type TelegramUpdate,
} from "./telegram-client"
import { createSanctuaryToolContext } from "./sanctuary-runtime"
import { createTelegramApprovalRuntime, type TelegramApprovalRuntime } from "./telegram-approval-runtime"
import type { SanctuaryHealthSweepResult } from "./sanctuary-health"

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
const APPROVAL_EXPIRY_RECONCILE_INTERVAL_MS = 1_000
const TELEGRAM_SUBJECT_DOMAIN = "ouroboros.telegram.subject.v1"

export interface CreateTelegramSenseAppOptions {
  agentName: string
  credentials: TelegramSenseCredentials
  api?: TelegramBotApi
  offsetStore?: TelegramOffsetStore
  inboxStore?: TelegramUpdateInboxStore
  createLongPoll?: TelegramLongPollFactory
  runTurn?: TelegramTurnRunner
  approvalTransport?: TelegramApprovalTransport
  approvalRuntime?: TelegramApprovalRuntime
  healthSweep?: (() => Promise<SanctuaryHealthSweepResult>) & {
    markDeliveryAttempting?: (deliveryId: string) => void
    markDelivered?: (deliveryId: string, messageIds: number[]) => void
  }
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

function opaqueTelegramSubject(botToken: string, authorizedUserId: string, authorizedChatId: string): string {
  const payload = [
    TELEGRAM_SUBJECT_DOMAIN,
    `user:${authorizedUserId.length}:${authorizedUserId}`,
    `chat:${authorizedChatId.length}:${authorizedChatId}`,
  ].join("\0")
  return `tg_${createHmac("sha256", botToken).update(payload, "utf8").digest("base64url")}`
}

function redactTelegramPrivateValues(error: unknown, privateValues: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const privateValue of privateValues) message = message.split(privateValue).join("[redacted]")
  return message
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
  const subject = opaqueTelegramSubject(botToken, authorizedUserId, authorizedChatId)
  const transportError = (error: unknown): string => redactTelegramPrivateValues(
    error,
    [botToken, authorizedUserId, authorizedChatId],
  )
  const api = options.api ?? createTelegramBotApi({ token: botToken })
  const offsetStore = options.offsetStore ?? new FileTelegramOffsetStore(
    path.join(getAgentRoot(options.agentName), "state", "senses", "telegram", "offset.json"),
  )
  const inboxStore = options.inboxStore ?? new FileTelegramUpdateInboxStore(
    path.join(getAgentRoot(options.agentName), "state", "senses", "telegram", "inbox.json"),
  )
  const runTurn = options.runTurn ?? runSenseTurn
  const useSanctuaryRuntime = options.agentName === "sanctuary" && !options.runTurn
  const toolContext = useSanctuaryRuntime ? createSanctuaryToolContext(options.agentName) : undefined
  const approvalRuntime = options.approvalRuntime ?? (useSanctuaryRuntime ? createTelegramApprovalRuntime({
    agentName: options.agentName,
    api,
    authorizedUserId,
    authorizedChatId,
    toolContext: toolContext ?? {},
  }) : undefined)
  const approvalTransport = options.approvalTransport ?? approvalRuntime?.transport
  const healthSweep = options.healthSweep
  let approvalReconcileTimer: ReturnType<typeof setTimeout> | undefined
  let approvalReconciliationActive = false

  const clearApprovalReconcileTimer = (): void => {
    if (approvalReconcileTimer) clearTimeout(approvalReconcileTimer)
    approvalReconcileTimer = undefined
  }

  const scheduleApprovalReconcile = (): void => {
    if (!approvalTransport || !approvalReconciliationActive) return
    approvalReconcileTimer = setTimeout(() => {
      approvalReconcileTimer = undefined
      void approvalTransport.reconcileExpired().catch((error) => {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.telegram_approval_reconcile_error",
          message: "Telegram approval expiry reconciliation failed",
          meta: { agentName: options.agentName, subject, error: transportError(error) },
        })
      }).finally(scheduleApprovalReconcile)
    }, APPROVAL_EXPIRY_RECONCILE_INTERVAL_MS)
  }

  const runHealthSweep = async (): Promise<void> => {
    if (!healthSweep) return
    try {
      const result = await healthSweep()
      if (result.message) {
        if (result.deliveryId) await healthSweep.markDeliveryAttempting?.(result.deliveryId)
        const messageIds = await deliver(result.message)
        if (result.deliveryId) await healthSweep.markDelivered?.(result.deliveryId, messageIds)
      }
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.sanctuary_health_error",
        message: "Sanctuary deterministic health sweep failed",
        meta: { agentName: options.agentName, subject, error: transportError(error) },
      })
    }
  }

  const deliver = async (text: string, signal?: AbortSignal): Promise<number[]> => {
    return sendTelegramText(api, authorizedChatId, text, signal)
  }

  const onMessage = async (message: TelegramInboundMessage): Promise<void> => {
    emitNervesEvent({
      component: "senses",
      event: "senses.telegram_turn_start",
      message: "Telegram authorized turn started",
      meta: { agentName: options.agentName, subject },
    })
    let deliveryCount = 0
    try {
      const result = await runTurn({
        agentName: options.agentName,
        channel: "telegram",
        sessionKey: `telegram:${subject}`,
        friendId: `telegram-user:${subject}`,
        identity: {
          provider: "telegram-user",
          externalId: subject,
          displayName: `Telegram user ${subject}`,
        },
        userMessage: message.text,
        deliverySink: {
          onDelivery: async (delivery) => {
            await deliver(delivery.text)
            deliveryCount += 1
          },
        },
        ...(toolContext ? { toolContext } : {}),
        ...(approvalRuntime ? { approvalCoordinatorFactory: approvalRuntime.coordinator } : {}),
      })
      if (deliveryCount === 0 && result.response.trim()) await deliver(result.response)
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_turn_end",
        message: "Telegram authorized turn completed",
        meta: { agentName: options.agentName, subject, deliveryCount: Math.max(deliveryCount, result.response.trim() ? 1 : 0) },
      })
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.telegram_turn_error",
        message: "Telegram authorized turn failed",
        meta: {
          agentName: options.agentName,
          subject,
          error: redactTelegramPrivateValues(
            error,
            [botToken, authorizedUserId, authorizedChatId, String(message.updateId), message.messageId],
          ),
        },
      })
      await deliver("I couldn't complete that turn. The failure was recorded; please try again.")
    }
  }

  const onUpdate = async (update: TelegramUpdate): Promise<boolean> => {
    if (!update.callback_query || !approvalTransport) return false
    const result = await approvalTransport.handleUpdate(update)
    return result.handled
  }

  const poll = (options.createLongPoll ?? createTelegramLongPoll)({
    api,
    expectedUserId: authorizedUserId,
    expectedChatId: authorizedChatId,
    offsetStore,
    inboxStore,
    onMessage,
    onUpdate,
  })

  return {
    async run(signal) {
      await approvalRuntime?.recover()
      await approvalTransport?.reconcileExpired()
      await runHealthSweep()
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_poll_start",
        message: "Telegram long poll started",
        meta: { agentName: options.agentName, subject },
      })
      approvalReconciliationActive = true
      scheduleApprovalReconcile()
      try {
        await poll.run(signal)
      } finally {
        approvalReconciliationActive = false
        clearApprovalReconcileTimer()
      }
    },
    async sendProactive(text, signal) {
      await deliver(requiredText(text, "proactive message"), signal)
    },
    stop() {
      approvalReconciliationActive = false
      clearApprovalReconcileTimer()
      poll.stop()
      api.stop()
      approvalRuntime?.close()
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_poll_end",
        message: "Telegram long poll stopped",
        meta: { agentName: options.agentName, subject },
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
