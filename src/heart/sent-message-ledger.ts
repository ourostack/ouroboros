import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { writeFileAtomicSync } from "./atomic-file"
import type { ChatMessageLookup } from "./chat-interaction"

/**
 * The messages the agent sent on a chat app that keeps no history the agent can read back, keyed by the id the app gave
 * each one. When someone reacts to one of them the app sends only that id, and this is how the agent learns what it said.
 * A sense whose app or journal already answers that (BlueBubbles' server, Telegram's effect journal) uses its own record
 * instead, so no message is kept twice. Lives under the agent's ignored `state/`, newest entries kept, text excerpted.
 */
export const SENT_MESSAGE_LEDGER_MAX_ENTRIES = 500
export const SENT_MESSAGE_LEDGER_MAX_TEXT = 500

interface SentMessageEntry {
  key: string
  text: string
  sentAt: string
}

interface SentMessageLedgerFile {
  version: 1
  entries: SentMessageEntry[]
}

export interface SentMessageLedgerScope {
  agentRoot: string
  /** The sense, such as "teams". */
  channel: string
  /** The app's conversation id, so the same message id in two conversations never collides. */
  conversationId: string
}

function ledgerPath(agentRoot: string, channel: string): string {
  return path.join(agentRoot, "state", "senses", "sent-messages", `${channel.replace(/[^\w.-]/g, "_")}.json`)
}

function entryKey(conversationId: string, messageId: string): string {
  return createHash("sha256").update(`${conversationId}\0${messageId}`).digest("hex")
}

function readLedger(file: string): SentMessageEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SentMessageLedgerFile>
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((entry): entry is SentMessageEntry => typeof entry?.key === "string" && typeof entry.text === "string")
      : []
  } catch {
    return []
  }
}

/** Note a message the agent sent. Never throws: losing one entry only means a later reaction to it reads as unidentified. */
export function recordSentMessage(scope: SentMessageLedgerScope, messageId: string, text: string, now: Date = new Date()): void {
  const trimmed = text.trim()
  if (!messageId || !trimmed) return
  const file = ledgerPath(scope.agentRoot, scope.channel)
  try {
    const key = entryKey(scope.conversationId, messageId)
    const entries = readLedger(file).filter((entry) => entry.key !== key)
    entries.push({ key, text: trimmed.slice(0, SENT_MESSAGE_LEDGER_MAX_TEXT), sentAt: now.toISOString() })
    const body: SentMessageLedgerFile = { version: 1, entries: entries.slice(-SENT_MESSAGE_LEDGER_MAX_ENTRIES) }
    writeFileAtomicSync(file, `${JSON.stringify(body)}\n`)
    emitNervesEvent({ component: "senses", event: "senses.sent_message_recorded", message: "noted a sent message for later reactions", meta: { channel: scope.channel } })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.sent_message_record_failed", message: "could not note a sent message", meta: { channel: scope.channel, reason: error instanceof Error ? error.message : String(error) } })
  }
}

/** A lookup for `resolveChatInteractionTarget` over this ledger: messages found here are always the agent's. */
export function sentMessageLookup(scope: SentMessageLedgerScope): ChatMessageLookup {
  return (messageId) => {
    const key = entryKey(scope.conversationId, messageId)
    const entry = readLedger(ledgerPath(scope.agentRoot, scope.channel)).find((candidate) => candidate.key === key)
    return entry ? { text: entry.text, fromAgent: true } : null
  }
}
