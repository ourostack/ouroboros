import type { FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { sanitizeKey } from "./config"
import { listSessionActivity, type SessionActivityRecord } from "./session-activity"

/** Channels an agent can reach a person on outside a live conversation. */
export const REACH_CHANNELS = ["bluebubbles", "teams"] as const
export type ReachChannel = typeof REACH_CHANNELS[number]

/**
 * Where to reach a friend: a channel, the existing 1:1 session key on it (null when there is none yet, so the sender's
 * returned key is used), and the friend's id on that channel (`handle`, lowercased, which is also the dedupe identity).
 */
export type ReachTarget =
  | { channel: ReachChannel; key: string | null; friendId: string; handle: string; tenantId?: string }
  | { unreachable: string; friendId: string }

interface Reachable { channel: ReachChannel; handle: string; tenantId?: string }

function isReachChannel(value: unknown): value is ReachChannel {
  return typeof value === "string" && (REACH_CHANNELS as readonly string[]).includes(value)
}

/** The friend's id on a channel, when that channel is enabled and the friend has one. */
function reachableOn(friend: FriendRecord, channel: ReachChannel, enabled: ReadonlySet<ReachChannel>): Reachable | null {
  if (!enabled.has(channel)) return null
  const provider = channel === "bluebubbles" ? "imessage-handle" : "aad"
  const ids = Array.isArray(friend.externalIds) ? friend.externalIds : []
  const id = ids.find(entry => entry?.provider === provider && typeof entry.externalId === "string" && entry.externalId.trim() !== "" &&
    !(channel === "teams" && entry.externalId.startsWith("group:")))
  if (!id) return null
  return { channel, handle: id.externalId.toLowerCase(), ...(channel === "teams" && id.tenantId ? { tenantId: id.tenantId } : {}) }
}

/**
 * A 1:1 session key, read back from its sanitized filename. A BlueBubbles key is 1:1 when it is a DM chat GUID
 * (`chat_<service>;-;<handle>`) or the chat-identifier fallback naming this friend's own handle; a group never is.
 * A Teams key is 1:1 when it is a personal conversation id (`a:` sanitized to `a_`).
 */
function isOneToOne(channel: ReachChannel, key: string, friend: FriendRecord): boolean {
  if (channel === "teams") return key.startsWith("a_")
  if (key.includes(";+;")) return false
  if (key.startsWith("chat_") && key.includes(";-;")) return true
  const handle = reachableOn(friend, "bluebubbles", new Set(["bluebubbles"]))?.handle
  return handle !== undefined && key.toLowerCase() === `chat_identifier_${sanitizeKey(handle)}`
}

/** The friend's own 1:1 sessions, newest inbound first. Messages the agent recorded never rank a session. */
function friendSessions(input: { friend: FriendRecord; sessionsDir: string; friendsDir: string; agentName: string; nowMs: number }): Array<SessionActivityRecord & { channel: ReachChannel }> {
  return listSessionActivity({ sessionsDir: input.sessionsDir, friendsDir: input.friendsDir, agentName: input.agentName,
    activeThresholdMs: Number.POSITIVE_INFINITY, nowMs: input.nowMs })
    .filter((record): record is SessionActivityRecord & { channel: ReachChannel } =>
      record.friendId === input.friend.id && record.activitySource === "friend-facing" && record.lastInboundAt !== null &&
      isReachChannel(record.channel) && isOneToOne(record.channel, record.key, input.friend))
    .sort((a, b) => Date.parse(b.lastInboundAt!) - Date.parse(a.lastInboundAt!))
}

/**
 * Chooses the channel that reaches a friend outside a live conversation: their stated preference when it is current and
 * reachable, else the channel of their newest 1:1 session, else any reachable channel (BlueBubbles, then Teams).
 */
export function resolveReachTarget(input: {
  friend: FriendRecord
  enabledChannels: ReadonlySet<ReachChannel>
  sessionsDir: string
  friendsDir: string
  agentName: string
  now?: () => number
}): ReachTarget {
  const { friend, enabledChannels } = input
  const nowMs = (input.now ?? Date.now)()
  const sessions = friendSessions({ ...input, nowMs })
  const target = (reach: Reachable): ReachTarget => ({
    channel: reach.channel, key: sessions.find(record => record.channel === reach.channel)?.key ?? null,
    friendId: friend.id, handle: reach.handle, ...(reach.tenantId ? { tenantId: reach.tenantId } : {}),
  })

  const stated = friend.relationshipPolicy?.preferences.reachChannel
  const current = stated && (stated.provenance === "stated" || stated.provenance === "default") && isReachChannel(stated.value) &&
    (!stated.expiresAt || Date.parse(stated.expiresAt) > nowMs)
  const preferred = current ? stated.value as ReachChannel : null
  const preferredReach = preferred ? reachableOn(friend, preferred, enabledChannels) : null
  if (preferredReach) return target(preferredReach)

  let chosen: Reachable | null = null
  for (const record of sessions) {
    chosen = reachableOn(friend, record.channel, enabledChannels)
    if (chosen) break
  }
  for (const channel of REACH_CHANNELS) {
    if (chosen) break
    chosen = reachableOn(friend, channel, enabledChannels)
  }

  if (preferred) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.reach_channel_fallback",
      message: `${preferred} cannot reach this friend, so the notice goes ${chosen ? `on ${chosen.channel}` : "nowhere"}`,
      meta: { friendId: friend.id, preferred, chosen: chosen?.channel ?? null } })
  }
  return chosen ? target(chosen) : { unreachable: `no reachable channel: enable BlueBubbles or Teams and link this friend's id`, friendId: friend.id }
}
