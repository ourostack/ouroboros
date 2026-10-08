import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The replay gate drives the Butler over its real A2A path to check its behaviour after an upgrade. Every delegated
 * command and every A2A-filed await would otherwise post to the owner's Telegram chat. While the host's gate holds a
 * replay window open for a peer, those notices are appended to a local sink instead.
 *
 * The window narrows where a notice goes, never whether a command is authorized: the grant, family trust, sole owner
 * and notify-before-run checks are unchanged, and "notify" means "the sink write succeeded". The window file lives
 * under the bundle's state directory, is written by the host's gate and cleared when its run ends, and every entry
 * expires on its own (and is ignored if it claims to last longer than the cap).
 */
export const REPLAY_WINDOW_MAX_MS = 2 * 60 * 60 * 1000

export interface ReplayNotice {
  noticeId: string
  text: string
  friendId: string
}

function replayDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "replay")
}

export function replayWindowPath(agentRoot: string): string {
  return path.join(replayDir(agentRoot), "window.json")
}

export function replaySinkPath(agentRoot: string): string {
  return path.join(replayDir(agentRoot), "notices.ndjson")
}

/** True only when the window file lists `friendId` with an expiry that is in the future and within the cap. Any unreadable or malformed file means "closed". */
export function isReplayWindowOpen(agentRoot: string, friendId: string, now: number = Date.now()): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(replayWindowPath(agentRoot), "utf8"))
  } catch {
    return false
  }
  const friends = (parsed as { friends?: unknown } | null)?.friends
  if (!friends || typeof friends !== "object") return false
  const entry = (friends as Record<string, unknown>)[friendId]
  const expiresAt = typeof (entry as { expiresAt?: unknown } | null)?.expiresAt === "string"
    ? Date.parse((entry as { expiresAt: string }).expiresAt)
    : Number.NaN
  return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + REPLAY_WINDOW_MAX_MS
}

/** Appends one notice to the sink; throws when it cannot be written, so the caller refuses exactly as a failed Telegram send does. */
export function appendReplayNotice(agentRoot: string, notice: ReplayNotice, now: number = Date.now()): void {
  fs.mkdirSync(replayDir(agentRoot), { recursive: true })
  const line = JSON.stringify({ at: new Date(now).toISOString(), ...notice })
  fs.appendFileSync(replaySinkPath(agentRoot), `${line}\n`, { mode: 0o600 })
  emitNervesEvent({
    component: "senses",
    event: "senses.a2a_replay_notice_sunk",
    message: "wrote an owner notice to the replay sink instead of Telegram",
    meta: { noticeId: notice.noticeId, friendId: notice.friendId },
  })
}

/** True when the sink holds a notice with this id (a missing sink is "no"). */
export function replayNoticeRecorded(agentRoot: string, noticeId: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(replaySinkPath(agentRoot), "utf8")
  } catch {
    return false
  }
  return raw.split("\n").some((line) => {
    if (!line) return false
    try {
      const entry = JSON.parse(line) as { noticeId?: unknown }
      return entry.noticeId === noticeId
    } catch {
      return false
    }
  })
}
