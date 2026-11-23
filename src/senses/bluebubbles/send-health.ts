import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomicSync } from "../../heart/atomic-file"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Whether BlueBubbles can send, as the last send found it. The listener's health check only proves BlueBubbles
 * answers; it cannot see macOS refusing BlueBubbles' control of Messages. Any process that sends records here,
 * and the daemon's status reads it, so a sense that cannot send never reads as healthy.
 *
 * Kept apart from runtime.json, which only the listener writes.
 */
export interface BlueBubblesSendHealth {
  status: "ok" | "blocked"
  /** The failure's code, while blocked. */
  code?: string
  /** What is wrong and what a person must do, while blocked. */
  detail?: string
  /** When sends started failing this way. */
  since?: string
  lastFailureAt?: string
  lastDeliveredAt?: string
}

export function getBlueBubblesSendHealthPath(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(agentRoot, "state", "senses", "bluebubbles", "send-health.json")
}

export function readBlueBubblesSendHealth(agentName: string, agentRoot?: string): BlueBubblesSendHealth | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getBlueBubblesSendHealthPath(agentName, agentRoot), "utf-8")) as Partial<BlueBubblesSendHealth>
    if (parsed.status !== "ok" && parsed.status !== "blocked") return null
    const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
    return {
      status: parsed.status,
      ...(text(parsed.code) ? { code: text(parsed.code) } : {}),
      ...(text(parsed.detail) ? { detail: text(parsed.detail) } : {}),
      ...(text(parsed.since) ? { since: text(parsed.since) } : {}),
      ...(text(parsed.lastFailureAt) ? { lastFailureAt: text(parsed.lastFailureAt) } : {}),
      ...(text(parsed.lastDeliveredAt) ? { lastDeliveredAt: text(parsed.lastDeliveredAt) } : {}),
    }
  } catch {
    return null
  }
}

function writeSendHealth(agentName: string, health: BlueBubblesSendHealth, agentRoot?: string): void {
  try {
    writeJsonAtomicSync(getBlueBubblesSendHealthPath(agentName, agentRoot), health)
  } catch (error) {
    // Recording must never turn a send result into a different failure.
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_send_health_write_error",
      message: "failed to record bluebubbles send health",
      meta: { agentName, status: health.status, reason: String(error) },
    })
  }
}

/** A send failed in a way no retry fixes until something changes on the host. */
export function recordBlueBubblesSendBlocked(
  agentName: string,
  failure: { code: string; detail: string },
  agentRoot?: string,
  now: () => number = Date.now,
): void {
  const previous = readBlueBubblesSendHealth(agentName, agentRoot)
  const at = new Date(now()).toISOString()
  const continuing = previous?.status === "blocked" && previous.code === failure.code
  writeSendHealth(agentName, {
    status: "blocked",
    code: failure.code,
    detail: failure.detail,
    since: continuing && previous.since ? previous.since : at,
    lastFailureAt: at,
    ...(previous?.lastDeliveredAt ? { lastDeliveredAt: previous.lastDeliveredAt } : {}),
  }, agentRoot)
  if (!continuing) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.bluebubbles_send_blocked",
      message: "bluebubbles sends are blocked on the host",
      meta: { agentName, code: failure.code },
    })
  }
}

/** A send went through: clear a recorded block. Writes only when one was recorded, so healthy sends cost nothing. */
export function recordBlueBubblesSendDelivered(agentName: string, agentRoot?: string, now: () => number = Date.now): void {
  const previous = readBlueBubblesSendHealth(agentName, agentRoot)
  if (previous?.status !== "blocked") return
  writeSendHealth(agentName, { status: "ok", lastDeliveredAt: new Date(now()).toISOString() }, agentRoot)
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_send_unblocked",
    message: "bluebubbles sends work again",
    meta: { agentName, previousCode: previous.code, blockedSince: previous.since },
  })
}
