/**
 * Ari sometimes hands his Telegram chat to someone else ("I'm going to hand you to my wife, Rachel"). For a while after that,
 * the chat is that person's conversation, so house notices (an outage, a recovery) wait instead of landing in it
 * (2026-10-11: two Jellyfin outage notes went into Rachel's movie chat). The window runs until the chat has been quiet for two
 * hours, so a long conversation is never interrupted. Pure functions plus a small held-notice file; the Telegram sense wires them in.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
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

/**
 * Proactive pacing: at most PROACTIVE_DAILY_CAP unprompted owner messages per local day, and none in quiet hours
 * (23:00-08:00 local), except critical ones (array or disk failure, parity errors). A held message waits in the same
 * held-notice file and goes out, folded into one message, at the next allowed moment.
 */
export const PROACTIVE_DAILY_CAP = 3
export const QUIET_HOURS = { start: 23, end: 8 } as const
const CRITICAL_NOTICE = /\b(?:disk:[^"\s]*:smart|parity:|disk:array:state)/u

export interface ProactivePacing { timeZone: string }
interface ProactiveLedger { day: string; count: number }

function localParts(now: Date, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((part) => [part.type, part.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}

export function isQuietHour(now: Date, pacing: ProactivePacing): boolean {
  const { hour } = localParts(now, pacing.timeZone)
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end
}

export function isCriticalNoticeKey(key: string): boolean {
  return CRITICAL_NOTICE.test(key)
}

function readProactiveLedger(filePath: string): ProactiveLedger | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ProactiveLedger>
    return typeof parsed.day === "string" && Number.isSafeInteger(parsed.count) ? { day: parsed.day, count: parsed.count! } : null
  } catch {
    return null
  }
}

/** Why a non-critical proactive message must wait now, or null when it may go. */
export function proactiveHoldReason(ledgerPath: string, now: Date, pacing: ProactivePacing): "quiet_hours" | "daily_cap" | null {
  if (isQuietHour(now, pacing)) return "quiet_hours"
  const ledger = readProactiveLedger(ledgerPath)
  return ledger?.day === localParts(now, pacing.timeZone).day && ledger.count >= PROACTIVE_DAILY_CAP ? "daily_cap" : null
}

export function recordProactiveSend(ledgerPath: string, now: Date, pacing: ProactivePacing): void {
  const day = localParts(now, pacing.timeZone).day
  const ledger = readProactiveLedger(ledgerPath)
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  fs.writeFileSync(ledgerPath, JSON.stringify({ day, count: ledger?.day === day ? ledger.count + 1 : 1 }), { mode: 0o600 })
}

/** Several held notices go out as one message so a quiet night never becomes a morning burst. */
export function foldHeldNotices(held: readonly HeldNotice[]): HeldNotice {
  if (held.length === 1) return held[0]!
  return { key: `held-batch:${createHash("sha256").update(held.map((notice) => notice.key).join("\0")).digest("hex").slice(0, 32)}`, text: ["While you were away:", ...held.map((notice) => `- ${notice.text}`)].join("\n") }
}

const RELEASED_KEYS_LIMIT = 500

/** Keys of held notices that went out inside a folded batch, so a retried decision sees its message already exists. */
export function readReleasedHeldKeys(filePath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

export function recordReleasedHeldKeys(filePath: string, keys: readonly string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const next = [...readReleasedHeldKeys(filePath).filter((key) => !keys.includes(key)), ...keys].slice(-RELEASED_KEYS_LIMIT)
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}
