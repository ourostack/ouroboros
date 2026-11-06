import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  parseAwaitFile,
  renderAwaitFile,
  type AwaitFile,
} from "./await-parser"
import { readAwaitRuntimeState } from "./await-runtime-state"
import { deliverAwaitAlert } from "./await-alert"
import type { CrossChatDeliveryDeps } from "../cross-chat-delivery"

export interface ArchiveExpiredAwaitOptions {
  agentRoot: string
  agentName: string
  awaitName: string
  /** Cross-chat delivery deps for sending the expiry alert. */
  deliveryDeps: CrossChatDeliveryDeps
  /** Defaults to `() => new Date()` — overridable for tests. */
  now?: () => Date
}

export interface ArchiveExpiredAwaitResult {
  archived: boolean
  alerted: boolean
  reason?: string
}

/**
 * Daemon-side max_age expiry helper. Reads the pending await, moves it to
 * `awaiting/.done/` with `status: expired`, writes `expired_at` and
 * `last_observation_at_expiry`, then fires the alert via deliverAwaitAlert.
 *
 * Idempotent w.r.t. the alert path: if the file is gone (already archived
 * by a concurrent path) it returns `archived: false` without alerting.
 */
export async function archiveAndAlertExpiredAwait(options: ArchiveExpiredAwaitOptions): Promise<ArchiveExpiredAwaitResult> {
  const now = options.now ?? (() => new Date())
  const source = path.join(options.agentRoot, "awaiting", `${options.awaitName}.md`)
  const doneDir = path.join(options.agentRoot, "awaiting", ".done")
  const target = path.join(doneDir, `${options.awaitName}.md`)

  let content: string
  try {
    content = fs.readFileSync(source, "utf-8")
  } catch {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.await_expiry_skip",
      message: "expired await file no longer present at archive time",
      meta: { agent: options.agentName, awaitName: options.awaitName },
    })
    return { archived: false, alerted: false, reason: "file missing" }
  }

  const parsed = parseAwaitFile(content, source)
  const runtime = readAwaitRuntimeState(options.agentRoot, options.awaitName)
  const lastObservation = runtime?.last_observation ?? null

  const expiredAt = now().toISOString()
  const merged: Record<string, unknown> = {
    condition: parsed.condition,
    cadence: parsed.cadence,
    alert: parsed.alert,
    mode: parsed.mode,
    max_age: parsed.max_age,
    status: "expired",
    created_at: parsed.created_at,
    filed_from: parsed.filed_from,
    filed_for_friend_id: parsed.filed_for_friend_id,
    expired_at: expiredAt,
    last_observation_at_expiry: lastObservation,
  }

  fs.mkdirSync(doneDir, { recursive: true })
  fs.writeFileSync(target, renderAwaitFile(merged, parsed.body), "utf-8")
  fs.unlinkSync(source)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.await_expired_archived",
    message: "expired await archived",
    meta: { agent: options.agentName, awaitName: options.awaitName, expiredAt },
  })

  // Re-parse archived file to feed the alert with merged fields
  const archivedContent = fs.readFileSync(target, "utf-8")
  const archived: AwaitFile = parseAwaitFile(archivedContent, target)

  const alertResult = await deliverAwaitAlert({
    awaitFile: archived,
    reason: "expired",
    observation: lastObservation,
    agentRoot: options.agentRoot,
    agentName: options.agentName,
    deliveryDeps: options.deliveryDeps,
  })

  return { archived: true, alerted: alertResult.attempted }
}
