/**
 * Ari sometimes hands his Telegram chat to someone else ("I'm going to hand you to my wife, Rachel"). For a while after that,
 * the chat is that person's conversation, so house notices (an outage, a recovery) wait instead of landing in it
 * (2026-10-11: two Jellyfin outage notes went into Rachel's movie chat). The window runs until the chat has been quiet for two
 * hours, so a long conversation is never interrupted. Pure functions plus a small held-notice file; the Telegram sense wires them in.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { extractEventText, type SessionEvent } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"

export const OWNER_CHAT_HANDOFF_MS = 2 * 60 * 60 * 1000

const HANDOFF_CUE = /\b(?:hand(?:ing)?|pass(?:ing)?)\s+you\s+(?:(?:over|off)\s+)?to\b|\bsay\s+(?:hi|hello)\s+to\s+(?:her|him|them)\b/i

/** True when the owner's chat was handed to someone else and has had a message from them within the window. */
export function ownerChatHandedOff(events: readonly SessionEvent[], now: number): boolean {
  let lastMessageAt: number | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.role !== "user") continue
    lastMessageAt ??= Date.parse(event.time.observedAt ?? event.time.recordedAt)
    if (HANDOFF_CUE.test(extractEventText(event))) return Number.isFinite(lastMessageAt) && now - lastMessageAt < OWNER_CHAT_HANDOFF_MS
  }
  return false
}

export interface HeldNotice { key: string; text: string }

export function readHeldNotices(filePath: string): HeldNotice[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is HeldNotice => typeof entry?.key === "string" && typeof entry?.text === "string") : []
  } catch {
    return []
  }
}

export function writeHeldNotices(filePath: string, notices: readonly HeldNotice[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(notices), { mode: 0o600 })
  fs.renameSync(temporary, filePath)
  emitNervesEvent({ component: "senses", event: "senses.telegram_held_notices_saved", message: "saved the house notices held during a handoff", meta: { held: notices.length } })
}
