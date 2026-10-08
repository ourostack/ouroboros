import * as fs from "node:fs"
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

/** Permanent registry of replay identities, written by the host's provisioning and never cleared. */
export function replayIdentitiesPath(agentRoot: string): string {
  return path.join(replayDir(agentRoot), "identities.json")
}

function listsFriend(file: string, friendId: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    // A missing file lists nobody; a file that exists but cannot be read or parsed fails closed.
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
  }
  const friends = (parsed as { friends?: unknown } | null)?.friends
  return !!friends && typeof friends === "object" && Object.hasOwn(friends, friendId)
}

/**
 * True when `friendId` is a replay identity: listed in the permanent registry, or holding any window entry (open or
 * expired). Unlike the window check this needs no trusted-owner proof, because the marker only ever restricts: forging
 * an entry can block a friend from writing owner policy, never grant anything. Owner policy writes refuse these identities.
 */
export function isReplayIdentity(agentRoot: string, friendId: string): boolean {
  return listsFriend(replayIdentitiesPath(agentRoot), friendId) || listsFriend(replayWindowPath(agentRoot), friendId)
}

/** A root-controlled directory: a real directory (no symlink), owned by the trusted uid, writable by neither group nor other. */
function isTrustedDirectory(target: string, trustedUid: number): boolean {
  try {
    const stat = fs.lstatSync(target)
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === trustedUid && (stat.mode & 0o022) === 0
  } catch {
    return false
  }
}

/**
 * Reads the window file only if the file actually opened is trusted. The path is opened once with O_NOFOLLOW, then the
 * descriptor itself is checked (regular file, trusted owner, not group- or other-writable) and read, so a rename loop on
 * the Butler's own state directory cannot swap a different file in between the check and the read. Any error is "no window".
 */
function readTrustedWindow(file: string, trustedUid: number): unknown {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== trustedUid || (stat.mode & 0o022) !== 0) return undefined
    return JSON.parse(fs.readFileSync(fd, "utf8"))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * True only when the window file lists `friendId` with an expiry that is in the future and within the cap. Any unreadable or malformed file means "closed".
 * The state directory is the Butler's own, so it could swap in a directory and window of its own making: only a replay
 * directory and window file that root owns, and nobody else can write, count; anything else fails toward Telegram.
 */
export function isReplayWindowOpen(agentRoot: string, friendId: string, now: number = Date.now(), trustedUid: number = 0): boolean {
  if (!isTrustedDirectory(replayDir(agentRoot), trustedUid)) return false
  const parsed = readTrustedWindow(replayWindowPath(agentRoot), trustedUid)
  const friends = (parsed as { friends?: unknown } | null)?.friends
  if (!friends || typeof friends !== "object") return false
  const entry = (friends as Record<string, unknown>)[friendId]
  const expiresAt = typeof (entry as { expiresAt?: unknown } | null)?.expiresAt === "string"
    ? Date.parse((entry as { expiresAt: string }).expiresAt)
    : Number.NaN
  return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + REPLAY_WINDOW_MAX_MS
}

/** Appends one notice to the sink, once per notice id and friend (a retry after a crash adds nothing); throws when it cannot be written, so the caller refuses exactly as a failed Telegram send does. */
export function appendReplayNotice(agentRoot: string, notice: ReplayNotice, now: number = Date.now()): void {
  if (replayNoticeRecorded(agentRoot, notice.noticeId, notice.friendId)) return
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

/** True when the sink holds a notice with this id for this friend (a missing sink is "no"). The sink is Butler-writable: callers must also require a trusted window. */
export function replayNoticeRecorded(agentRoot: string, noticeId: string, friendId: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(replaySinkPath(agentRoot), "utf8")
  } catch {
    return false
  }
  return raw.split("\n").some((line) => {
    if (!line) return false
    try {
      const entry = JSON.parse(line) as { noticeId?: unknown; friendId?: unknown }
      return entry.noticeId === noticeId && entry.friendId === friendId
    } catch {
      return false
    }
  })
}
