import * as path from "node:path"

import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
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
}

export async function runSanctuaryHealthHabit(
  agentName: string,
  options: SanctuaryHealthHabitRunnerOptions = {},
): Promise<SanctuaryHealthHabitResult> {
  const credentials = (options.credentials ?? loadTelegramSenseCredentials)(agentName)
  const api = (options.createApi ?? ((token) => createTelegramBotApi({ token })))(credentials.botToken)
  const sweep = options.createSweep?.(agentName) ?? createSanctuaryHealthSweep({
    toolContext: createSanctuaryToolContext(agentName),
    statePath: path.join(getAgentRoot(agentName), "state", "health", "sanctuary-health.json"),
  })
  try {
    const result = await sweep()
    if (result.message && result.deliveryId) {
      await sweep.markDeliveryAttempting?.(result.deliveryId)
      const messageIds = await sendTelegramText(api, credentials.authorizedChatId, result.message)
      await sweep.markDelivered?.(result.deliveryId, messageIds)
    }
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_habit", message: "Sanctuary native health habit completed", meta: { agentName, incidentCount: result.incidents.length, delivered: !!result.message } })
    return { ok: true, message: result.message ? "health sweep completed and delivered" : "health sweep completed with no alert", data: { incidentCount: result.incidents.length, delivered: !!result.message } }
  } finally {
    api.stop()
  }
}
