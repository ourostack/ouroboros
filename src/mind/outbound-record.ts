import * as fs from "fs"
import * as path from "path"
import { resolveSessionPath, sanitizeKey } from "../heart/config"
import type { OutboundOrigin } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { appendSyntheticAssistantMessage } from "./context"
import { currentSessionTurnLease, SessionTurnBusyError, withImmediateSessionTurnLease, type SessionTurnLease } from "./session-transaction"

/**
 * Saving a message the agent sent outside a conversation's own turn (a Shepherd notice, a send_message, a voice call)
 * into that conversation, so the friend's reply arrives with context.
 *
 * - `recorded`: appended to the session now.
 * - `deferred`: the session is mid-turn under another owner; the record waits in `state/outbound-records` and the
 *   owning sense drains it under its own lease before the friend's next message.
 * - `skipped_current_session`: the current turn is running in that very session, and its tool call is already there.
 * - `failed`: logged as `mind.outbound_record_error`; the delivery itself is never undone.
 */
export type OutboundRecordResult = "recorded" | "deferred" | "skipped_current_session" | "failed"

interface DeferredOutboundRecord {
  content: string
  origin: OutboundOrigin
  deliveryId: string
  originLabel: string
  recordedAt: string
}

function deferredDir(agentRoot: string, friendId: string, channel: string, key: string): string {
  return path.join(agentRoot, "state", "outbound-records", friendId, channel, sanitizeKey(key))
}

function recordedText(record: Pick<DeferredOutboundRecord, "content" | "originLabel">): string {
  return `[sent by ${record.originLabel}] ${record.content}`
}

function recordError(message: string, meta: Record<string, string | number | null>): void {
  emitNervesEvent({ level: "warn", component: "mind", event: "mind.outbound_record_error", message, meta })
}

function parseDeferred(raw: string): DeferredOutboundRecord | null {
  const value = JSON.parse(raw) as Partial<DeferredOutboundRecord> | null
  if (!value || typeof value.content !== "string" || typeof value.origin !== "string" || typeof value.deliveryId !== "string"
    || typeof value.originLabel !== "string" || typeof value.recordedAt !== "string") return null
  return value as DeferredOutboundRecord
}

/**
 * Appends every deferred record for this session in `recordedAt` order under the caller's lease, moving each file to
 * `applied/` beside it. Unreadable files are moved too, with an error event. Returns how many records were appended.
 */
export function drainOutboundRecords(agentRoot: string, friendId: string, channel: string, key: string, lease: SessionTurnLease): number {
  const dir = deferredDir(agentRoot, friendId, channel, key)
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return 0
  }
  if (names.length === 0) return 0
  const applied = path.join(dir, "applied")
  fs.mkdirSync(applied, { recursive: true })
  const entries: Array<{ name: string; record: DeferredOutboundRecord | null }> = names.map((name) => {
    try {
      return { name, record: parseDeferred(fs.readFileSync(path.join(dir, name), "utf8")) }
    } catch {
      return { name, record: null }
    }
  })
  entries.sort((a, b) => (a.record?.recordedAt ?? "").localeCompare(b.record?.recordedAt ?? ""))
  let count = 0
  for (const { name, record } of entries) {
    if (!record) {
      recordError("skipped an unreadable deferred outbound record", { friendId, channel, file: name })
    } else if (appendSyntheticAssistantMessage(lease.sessionPath, recordedText(record), lease,
      { outbound: { origin: record.origin, deliveryId: record.deliveryId }, createIfMissing: true })) {
      count += 1
    } else {
      recordError("could not append a deferred outbound record", { friendId, channel, file: name })
    }
    fs.renameSync(path.join(dir, name), path.join(applied, name))
  }
  return count
}

/** Records a delivered message in the friend's session on that channel. Never throws. */
export function recordOutboundInSession(input: {
  agentRoot: string
  friendId: string
  channel: "bluebubbles" | "teams"
  key: string
  content: string
  origin: OutboundOrigin
  deliveryId: string
  originLabel: string
}): OutboundRecordResult {
  const { agentRoot, friendId, channel, key, origin, deliveryId } = input
  try {
    const sessionPath = resolveSessionPath(friendId, channel, key, { agentRoot, confined: true })
    if (currentSessionTurnLease(sessionPath)) return "skipped_current_session"
    try {
      return withImmediateSessionTurnLease(sessionPath, (lease) => {
        drainOutboundRecords(agentRoot, friendId, channel, key, lease)
        const appended = appendSyntheticAssistantMessage(sessionPath, recordedText(input), lease,
          { outbound: { origin, deliveryId }, createIfMissing: true })
        if (appended) return "recorded" as const
        recordError("could not append an outbound record to its session", { friendId, channel, deliveryId })
        return "failed" as const
      })
    } catch (error) {
      if (!(error instanceof SessionTurnBusyError)) throw error
      const dir = deferredDir(agentRoot, friendId, channel, key)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${sanitizeKey(deliveryId)}.json`)
      const record: DeferredOutboundRecord = { content: input.content, origin, deliveryId, originLabel: input.originLabel, recordedAt: new Date().toISOString() }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      return "deferred"
    }
  } catch (error) {
    recordError("could not record an outbound message in its session", {
      friendId, channel, deliveryId, error: error instanceof Error ? error.message : String(error),
    })
    return "failed"
  }
}
