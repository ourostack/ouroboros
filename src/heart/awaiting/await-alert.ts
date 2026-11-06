import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  deliverCrossChatMessage,
  type CrossChatDeliveryDeps,
  type CrossChatDeliveryResult,
} from "../cross-chat-delivery"
import type { PendingMessage } from "../../mind/pending"
import type { AwaitFile } from "./await-parser"

export type AwaitAlertReason = "resolved" | "expired"

export interface AwaitAlertOptions {
  /** The await file (post-archive or pre-archive — only the fields are read). */
  awaitFile: AwaitFile
  /** Why we're alerting. Determines the message verb. */
  reason: AwaitAlertReason
  /**
   * Optional observation. For `resolved`, this is the resolution_observation.
   * For `expired`, this is the last observation at expiry. When null/empty,
   * the message falls back to "never observed".
   */
  observation: string | null
  /** Path to the bundle root (used for session-key resolution). */
  agentRoot: string
  /** The agent's own name (used as the `from` for queued pending envelopes). */
  agentName: string
  /** Cross-chat delivery dependencies (deliverers, queueing). */
  deliveryDeps: CrossChatDeliveryDeps
}

export interface AwaitAlertResult {
  /** True if delivery progressed (delivered_now or queued_for_later). */
  attempted: boolean
  /** The underlying delivery result, when a delivery attempt was made. */
  delivery?: CrossChatDeliveryResult
  /** Reason the alert was not attempted (missing channel/friend/etc). */
  skipped?: string
}

function readNonEmpty(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Find a session key for (friendId, channel) by scanning the bundle's
 * sessions directory. Prefers BlueBubbles DM keys (containing ";-;");
 * for other channels, returns the first available session file stem.
 *
 * Returns null when nothing is available — caller decides whether to skip
 * delivery or fall back to a default like "session".
 */
export function resolveAlertKey(agentRoot: string, friendId: string, channel: string): string | null {
  const dir = path.join(agentRoot, "state", "sessions", friendId, channel)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  const jsonFiles = entries.filter((f) => f.endsWith(".json"))
  if (jsonFiles.length === 0) return null
  const dm = jsonFiles.find((f) => f.includes(";-;"))
  const chosen = dm ?? jsonFiles[0]!
  return chosen.replace(/\.json$/, "")
}

export function buildAlertContent(awaitFile: AwaitFile, reason: AwaitAlertReason, observation: string | null): string {
  const condition = awaitFile.condition ?? awaitFile.name
  const obs = readNonEmpty(observation)
  if (reason === "resolved") {
    return obs ? `${condition} — ready. ${obs}` : `${condition} — ready.`
  }
  return obs ? `${condition} — timed out. last seen: ${obs}` : `${condition} — timed out. last seen: never observed`
}

export async function deliverAwaitAlert(options: AwaitAlertOptions): Promise<AwaitAlertResult> {
  const { awaitFile, reason, observation, agentRoot, deliveryDeps } = options

  emitNervesEvent({
    component: "daemon",
    event: "daemon.await_alert_start",
    message: "preparing await alert",
    meta: { awaitName: awaitFile.name, reason },
  })

  const channel = readNonEmpty(awaitFile.alert)
  const friendId = readNonEmpty(awaitFile.filed_for_friend_id)
  if (!channel) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.await_alert_end",
      message: "skipping alert — no alert channel configured",
      meta: { awaitName: awaitFile.name, reason },
    })
    return { attempted: false, skipped: "no alert channel" }
  }
  if (!friendId) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.await_alert_end",
      message: "skipping alert — no filed_for_friend_id",
      meta: { awaitName: awaitFile.name, reason },
    })
    return { attempted: false, skipped: "no friend id" }
  }

  const key = resolveAlertKey(agentRoot, friendId, channel)
  if (!key) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.await_alert_end",
      message: "skipping alert — no resolvable session key",
      meta: { awaitName: awaitFile.name, reason, friendId, channel },
    })
    return { attempted: false, skipped: "no session key" }
  }

  const content = buildAlertContent(awaitFile, reason, observation)
  const delivery = await deliverCrossChatMessage(
    {
      friendId,
      channel,
      key,
      content,
      intent: "generic_outreach",
    },
    deliveryDeps,
  )

  emitNervesEvent({
    component: "daemon",
    event: "daemon.await_alert_end",
    message: "await alert delivered",
    meta: { awaitName: awaitFile.name, reason, status: delivery.status },
  })

  return { attempted: true, delivery }
}

/**
 * Build a `CrossChatDeliveryDeps` from a minimal set of values needed by the
 * await alert path. Consumers in the daemon and tools both want the same
 * shape: write to inner-dialog pending dir as the queueing strategy, and
 * provide a `bluebubbles` deliverer that routes through the existing
 * proactive-send path.
 *
 * Concrete deliverer wiring lives in the daemon-entry/tool call site;
 * this is only the shape exposed for type-safe pass-through.
 */
export interface BuildAwaitDeliveryDepsOptions {
  agentName: string
  queuePending: (message: PendingMessage) => void
  deliverers?: CrossChatDeliveryDeps["deliverers"]
  now?: () => number
}

export function buildAwaitDeliveryDeps(options: BuildAwaitDeliveryDepsOptions): CrossChatDeliveryDeps {
  return {
    agentName: options.agentName,
    queuePending: options.queuePending,
    deliverers: options.deliverers,
    now: options.now,
  }
}
