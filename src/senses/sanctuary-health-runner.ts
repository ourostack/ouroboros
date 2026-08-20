import * as path from "node:path"

import { getAgentRoot } from "../heart/identity"
import { runAgent, type ChannelCallbacks } from "../heart/core"
import { recordAutonomyFailure, reserveAutonomyBudget, resolveAutonomyBudgetPolicy } from "../heart/autonomy-budget"
import { emitNervesEvent } from "../nerves/runtime"
import { resolveToolDefinition } from "../repertoire/tools"
import { createTelegramBotApi, sendTelegramText, type TelegramBotApi } from "./telegram-client"
import { createSanctuaryHealthSweep, type SanctuaryHealthSweepResult } from "./sanctuary-health"
import { createSanctuaryToolContext } from "./sanctuary-runtime"
import { loadTelegramSenseCredentials } from "./telegram"

export interface SanctuaryHealthHabitResult {
  ok: boolean
  message: string
  data?: { incidentCount: number; delivered: boolean }
}

export interface SanctuaryHealthHabitRunnerOptions {
  createSweep?: (agentName: string) => (() => Promise<SanctuaryHealthSweepResult>) & {
    markDeliveryAttempting?: (deliveryId: string) => void | Promise<void>
    markDelivered?: (deliveryId: string, messageIds: number[]) => void | Promise<void>
  }
  createApi?: (token: string) => TelegramBotApi
  credentials?: (agentName: string) => { botToken: string; authorizedChatId: string }
  runPrivateTurn?: (input: SanctuaryHealthPrivateTurnInput) => Promise<{ delivered: boolean }>
}

export interface SanctuaryHealthPrivateTurnInput {
  agentName: string
  eventId: string
  payload: string
  deliver: (content: string) => Promise<void>
}

function privateTurnCallbacks(): ChannelCallbacks {
  return {
    onModelStart() {}, onModelStreamStart() {}, onTextChunk() {}, onReasoningChunk() {},
    onToolStart() {}, onToolEnd() {}, onError() {}, onClearText() {},
  }
}

export async function runSanctuaryHealthPrivateTurn(input: SanctuaryHealthPrivateTurnInput): Promise<{ delivered: boolean }> {
  const definition = resolveToolDefinition("send_message")
  if (!definition) throw new Error("canonical send_message definition is unavailable")
  const agentRoot = getAgentRoot(input.agentName)
  const budgetTarget = { eventId: input.eventId, payloadStored: false }
  const budget = reserveAutonomyBudget(agentRoot, {
    agent: input.agentName,
    triggerType: "habit",
    sourceKind: "private-runtime",
    senseOrHabit: "sanctuary-health",
    target: budgetTarget,
    idempotencyKey: `sanctuary-health:${input.eventId}`,
  }, resolveAutonomyBudgetPolicy(agentRoot, input.agentName))
  if (!budget.allowed) throw new Error(`Sanctuary health private turn blocked: ${budget.reason}`)
  let delivered = false
  const result = await runAgent([
    {
      role: "user",
      content: [
        "A durable Sanctuary health event is pending.",
        `Event id: ${input.eventId}`,
        `Deterministic payload: ${input.payload}`,
        "Summarize it briefly for Ari. Call send_message exactly once with friendId=operator, channel=telegram, and the summary as content, then rest.",
      ].join("\n"),
    },
  ], privateTurnCallbacks(), "inner", undefined, {
    toolProfile: "sanctuary-health-private",
    tools: [definition.tool],
    toolContext: { signin: async () => undefined },
    execTool: async (name, args) => {
      if (name !== "send_message") throw new Error(`Sanctuary health profile cannot execute ${name}`)
      if (delivered) throw new Error("Sanctuary health Telegram delivery was already attempted")
      if (args.friendId !== "operator" || args.channel !== "telegram" || typeof args.content !== "string" || args.content.trim().length === 0) {
        throw new Error("Sanctuary health send_message target or content is invalid")
      }
      await input.deliver(args.content)
      delivered = true
      return "delivered"
    },
  })
  if (result.outcome === "errored") {
    recordAutonomyFailure(agentRoot, {
      agent: input.agentName,
      triggerType: "habit",
      sourceKind: "private-runtime",
      senseOrHabit: "sanctuary-health",
      provider: "configured-provider",
      target: budgetTarget,
      normalizedErrorName: result.error?.name ?? "ProviderError",
      normalizedErrorCode: result.errorClassification ?? "unknown",
      codeLocation: "sanctuary-health-private-turn",
      idempotencyBucket: input.eventId,
    }, resolveAutonomyBudgetPolicy(agentRoot, input.agentName))
    throw result.error ?? new Error("Sanctuary health private turn failed")
  }
  return { delivered }
}

export async function runSanctuaryHealthHabit(
  agentName: string,
  options: SanctuaryHealthHabitRunnerOptions = {},
): Promise<SanctuaryHealthHabitResult> {
  const sweep = options.createSweep?.(agentName) ?? createSanctuaryHealthSweep({
    toolContext: createSanctuaryToolContext(agentName),
    statePath: path.join(getAgentRoot(agentName), "state", "health", "sanctuary-health.json"),
  })
  const result = await sweep()
  if (!result.message || !result.deliveryId) {
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_habit", message: "Sanctuary native health habit completed without paid work", meta: { agentName, incidentCount: result.incidents.length, delivered: false } })
    return { ok: true, message: "health sweep completed with no alert", data: { incidentCount: result.incidents.length, delivered: false } }
  }
  const credentials = (options.credentials ?? loadTelegramSenseCredentials)(agentName)
  const api = (options.createApi ?? ((token) => createTelegramBotApi({ token })))(credentials.botToken)
  let attempted = false
  try {
    const privateResult = await (options.runPrivateTurn ?? runSanctuaryHealthPrivateTurn)({
      agentName,
      eventId: result.deliveryId,
      payload: result.message,
      deliver: async (content) => {
        if (attempted) throw new Error("Sanctuary health Telegram delivery was already attempted")
        attempted = true
        await sweep.markDeliveryAttempting?.(result.deliveryId!)
        const messageIds = await sendTelegramText(api, credentials.authorizedChatId, content)
        await sweep.markDelivered?.(result.deliveryId!, messageIds)
      },
    })
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_habit", message: "Sanctuary native health habit completed", meta: { agentName, incidentCount: result.incidents.length, delivered: privateResult.delivered } })
    return { ok: true, message: privateResult.delivered ? "health sweep completed and delivered" : "health event remains pending", data: { incidentCount: result.incidents.length, delivered: privateResult.delivered } }
  } finally {
    api.stop()
  }
}
