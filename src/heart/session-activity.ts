import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface SessionActivityRecord {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  lastActivityAt: string
  lastActivityMs: number
  activitySource: "friend-facing" | "mtime-fallback"
}

export interface SessionActivityQuery {
  sessionsDir: string
  friendsDir: string
  agentName: string
  activeThresholdMs?: number
  currentSession?: { friendId: string; channel: string; key: string } | null
}

const DEFAULT_ACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000

function activityPriority(source: SessionActivityRecord["activitySource"]): number {
  return source === "friend-facing" ? 0 : 1
}

function resolveFriendName(friendId: string, friendsDir: string, agentName: string): string {
  if (friendId === "self") return agentName
  try {
    const raw = fs.readFileSync(path.join(friendsDir, `${friendId}.json`), "utf-8")
    const parsed = JSON.parse(raw) as { name?: string }
    return parsed.name ?? friendId
  } catch {
    return friendId
  }
}

function parseFriendActivity(sessionPath: string): { lastActivityMs: number; lastActivityAt: string; activitySource: "friend-facing" | "mtime-fallback" } | null {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(sessionPath).mtimeMs
  } catch {
    return null
  }

  try {
    const raw = fs.readFileSync(sessionPath, "utf-8")
    const parsed = JSON.parse(raw) as { state?: { lastFriendActivityAt?: unknown } }
    const explicit = parsed?.state?.lastFriendActivityAt
    if (typeof explicit === "string") {
      const parsedMs = Date.parse(explicit)
      if (Number.isFinite(parsedMs)) {
        return {
          lastActivityMs: parsedMs,
          lastActivityAt: new Date(parsedMs).toISOString(),
          activitySource: "friend-facing",
        }
      }
    }
  } catch {
    // fall back to file mtime below
  }

  return {
    lastActivityMs: mtimeMs,
    lastActivityAt: new Date(mtimeMs).toISOString(),
    activitySource: "mtime-fallback",
  }
}

export function listSessionActivity(query: SessionActivityQuery): SessionActivityRecord[] {
  const {
    sessionsDir,
    friendsDir,
    agentName,
    activeThresholdMs = DEFAULT_ACTIVE_THRESHOLD_MS,
    currentSession = null,
  } = query

  emitNervesEvent({
    component: "daemon",
    event: "daemon.session_activity_scan",
    message: "scanning session activity",
    meta: {
      sessionsDir,
      currentSession: currentSession ? `${currentSession.friendId}/${currentSession.channel}/${currentSession.key}` : null,
    },
  })

  if (!fs.existsSync(sessionsDir)) return []

  const now = Date.now()
  const results: SessionActivityRecord[] = []

  let friendDirs: string[]
  try {
    friendDirs = fs.readdirSync(sessionsDir)
  } catch {
    return []
  }

  for (const friendId of friendDirs) {
    const friendPath = path.join(sessionsDir, friendId)
    let channels: string[]
    try {
      channels = fs.readdirSync(friendPath)
    } catch {
      continue
    }

    for (const channel of channels) {
      const channelPath = path.join(friendPath, channel)
      let keys: string[]
      try {
        keys = fs.readdirSync(channelPath)
      } catch {
        continue
      }

      for (const keyFile of keys) {
        if (!keyFile.endsWith(".json")) continue
        const key = keyFile.replace(/\.json$/, "")

        if (currentSession && friendId === currentSession.friendId && channel === currentSession.channel && key === currentSession.key) {
          continue
        }

        const sessionPath = path.join(channelPath, keyFile)
        const activity = parseFriendActivity(sessionPath)
        if (!activity) continue
        if (now - activity.lastActivityMs > activeThresholdMs) continue

        results.push({
          friendId,
          friendName: resolveFriendName(friendId, friendsDir, agentName),
          channel,
          key,
          sessionPath,
          lastActivityAt: activity.lastActivityAt,
          lastActivityMs: activity.lastActivityMs,
          activitySource: activity.activitySource,
        })
      }
    }
  }

  return results.sort((a, b) => {
    const sourceDiff = activityPriority(a.activitySource) - activityPriority(b.activitySource)
    if (sourceDiff !== 0) return sourceDiff
    return b.lastActivityMs - a.lastActivityMs
  })
}

export function findFreshestFriendSession(
  query: SessionActivityQuery & { friendId: string; activeOnly?: boolean },
): SessionActivityRecord | null {
  const {
    activeOnly = false,
    activeThresholdMs = DEFAULT_ACTIVE_THRESHOLD_MS,
    ...rest
  } = query

  const currentSession = rest.currentSession ?? null
  const all = activeOnly
    ? listSessionActivity({ ...rest, activeThresholdMs, currentSession })
    : listSessionActivity({ ...rest, activeThresholdMs: Number.MAX_SAFE_INTEGER, currentSession })

  return all.find((entry) => entry.friendId === query.friendId) ?? null
}
